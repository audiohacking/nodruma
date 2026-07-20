#include "pitch_zc.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>

namespace nodruma::detail {

std::vector<int> measure_halfcycle_widths(const float* samples, std::size_t start, std::size_t end,
                                         int ref_period_samples) {
  std::vector<int> widths;
  if (!samples || end <= start + 2 || ref_period_samples < 1) return widths;

  // Collect zero-crossing indices (sign changes), ignoring exact zeros as non-crossings.
  std::vector<int> zc;
  float prev = samples[start];
  for (std::size_t i = start + 1; i < end; ++i) {
    const float cur = samples[i];
    if ((prev < 0.f && cur >= 0.f) || (prev > 0.f && cur <= 0.f)) {
      zc.push_back(static_cast<int>(i));
    }
    if (cur != 0.f) prev = cur;
  }
  if (zc.size() < 2) return widths;

  const float ref = static_cast<float>(std::max(1, ref_period_samples));
  int last_accepted = zc.front();
  float last_width = static_cast<float>(zc[1] - zc[0]);
  if (last_width < 1.f) last_width = 1.f;

  for (std::size_t k = 1; k < zc.size(); ++k) {
    const int w_i = zc[k] - last_accepted;
    if (w_i < 1) continue;
    const float width = static_cast<float>(w_i);

    // Adaptive relative-deviation threshold (widens for longer / lower cycles).
    float threshold_frac = 0.3f;
    if (width > ref * 200.f) {
      threshold_frac = 0.6f;
    } else if (width < ref * 3.f) {
      threshold_frac = 0.3f;
    } else {
      const float num = width - ref * 3.f;
      const float den = ref * 197.f;
      const float t = num / std::max(den, 1.f);
      threshold_frac = 0.3f + 0.3f * (t * t);
    }

    const float rel = std::fabs(width - last_width) / std::max(last_width, 1.f);
    if (rel <= threshold_frac) {
      widths.push_back(w_i);
      last_accepted = zc[k];
      last_width = width;
    } else {
      // Spurious crossing: merge into neighboring segment (skip this ZC).
      // Do not update last_accepted — next width is measured from last accepted.
    }
  }

  // Drop trailing near-zero / invalid
  while (!widths.empty() && widths.back() < 1) widths.pop_back();
  return widths;
}

std::vector<float> frequency_envelope_from_widths(const std::vector<int>& widths,
                                                 double sample_rate) {
  std::vector<float> env;
  if (widths.empty() || sample_rate <= 0.0) return env;
  std::size_t total = 0;
  for (int w : widths) {
    if (w > 0) total += static_cast<std::size_t>(w);
  }
  env.resize(total, 0.f);
  std::size_t pos = 0;
  for (int w : widths) {
    if (w < 1) continue;
    // freqHz = sampleRate / (2 * half-cycle width)
    const float freq = static_cast<float>(sample_rate) / (2.f * static_cast<float>(w));
    for (int i = 0; i < w; ++i) env[pos++] = freq;
  }
  return env;
}

void expand_frequency_envelope(const std::vector<float>& step_freq, std::vector<float>& out,
                               std::size_t out_len, float fill_hz) {
  out.assign(out_len, fill_hz);
  if (step_freq.empty() || out_len == 0) return;
  const std::size_t n = std::min(out_len, step_freq.size());
  for (std::size_t i = 0; i < n; ++i) out[i] = step_freq[i];
  const float last = step_freq.back();
  for (std::size_t i = n; i < out_len; ++i) out[i] = last;
}

float estimate_kick_fundamental_hz(const float* samples, std::size_t n, double sample_rate,
                                   float min_hz, float max_hz) {
  if (!samples || n < 64 || sample_rate <= 0.0) return 0.f;
  min_hz = std::max(20.f, min_hz);
  max_hz = std::max(min_hz + 1.f, max_hz);

  const int min_lag = std::max(1, static_cast<int>(sample_rate / static_cast<double>(max_hz)));
  const int max_lag = std::min(static_cast<int>(n / 2),
                               static_cast<int>(sample_rate / static_cast<double>(min_hz)));
  if (max_lag <= min_lag + 1) return 0.f;

  // Mean-remove on a window (first ~200 ms or whole buffer)
  const std::size_t win = std::min(n, static_cast<std::size_t>(sample_rate * 0.2));
  double mean = 0.0;
  for (std::size_t i = 0; i < win; ++i) mean += samples[i];
  mean /= static_cast<double>(win);

  int best_lag = min_lag;
  double best = -1.0e300;
  for (int lag = min_lag; lag <= max_lag; ++lag) {
    double acc = 0.0;
    const std::size_t count = win - static_cast<std::size_t>(lag);
    for (std::size_t i = 0; i < count; ++i) {
      const double a = static_cast<double>(samples[i]) - mean;
      const double b = static_cast<double>(samples[i + static_cast<std::size_t>(lag)]) - mean;
      acc += a * b;
    }
    if (acc > best) {
      best = acc;
      best_lag = lag;
    }
  }
  return static_cast<float>(sample_rate / static_cast<double>(best_lag));
}

void anchor_pitch_envelope(std::vector<float>& pitch_hz, float anchor_hz, float min_hz, float max_hz) {
  if (pitch_hz.empty()) return;
  anchor_hz = std::clamp(anchor_hz, min_hz, max_hz);

  // Median of early contour — detect ZC failure / octave error
  const std::size_t n_early = std::min<std::size_t>(pitch_hz.size(), 2048);
  std::vector<float> early(pitch_hz.begin(), pitch_hz.begin() + static_cast<std::ptrdiff_t>(n_early));
  std::nth_element(early.begin(), early.begin() + static_cast<std::ptrdiff_t>(early.size() / 2),
                   early.end());
  float med = early[early.size() / 2];

  const bool zc_failed = (med > max_hz * 1.2f) || (med < min_hz * 0.5f) || (pitch_hz.size() < 64);
  // Octave-high if median ≈ 2× anchor
  const bool octave_high = (!zc_failed && med > anchor_hz * 1.55f && med < anchor_hz * 2.6f);
  const bool octave_low = (!zc_failed && med < anchor_hz * 0.65f && med > anchor_hz * 0.35f);

  if (zc_failed) {
    // Classic kick sweep into the anchor
    const std::size_t n = pitch_hz.size();
    const float f0 = std::min(max_hz, anchor_hz * 2.2f);
    for (std::size_t i = 0; i < n; ++i) {
      const float t = static_cast<float>(i) / static_cast<float>(std::max<std::size_t>(n, 1));
      const float e = std::exp(-t * 8.f);
      pitch_hz[i] = anchor_hz + (f0 - anchor_hz) * e;
    }
    return;
  }

  for (float& f : pitch_hz) {
    if (octave_high) f *= 0.5f;
    if (octave_low) f *= 2.f;
    // Keep folding toward anchor if still wild
    int guard = 0;
    while (f > anchor_hz * 1.7f && f * 0.5f >= min_hz && guard++ < 4) f *= 0.5f;
    guard = 0;
    while (f < anchor_hz * 0.55f && f * 2.f <= max_hz && guard++ < 4) f *= 2.f;
    f = std::clamp(f, min_hz, max_hz);
  }
}

void extend_decay_widths(std::vector<int>& widths, int extra_count) {
  if (widths.size() < 2 || extra_count < 1) return;
  const int a = widths[widths.size() - 1];
  const int b = widths[widths.size() - 2];
  int mean = (a + b) / 2;
  if (mean < 1) mean = 1;
  for (int i = 0; i < extra_count; ++i) widths.push_back(mean);
}

std::vector<int> widths_to_crossing_indices(const std::vector<int>& widths) {
  std::vector<int> zc;
  if (widths.empty()) return zc;
  zc.reserve(widths.size());
  int acc = widths.front();
  zc.push_back(acc);
  for (std::size_t i = 1; i < widths.size(); ++i) {
    acc += widths[i];
    zc.push_back(acc);
  }
  return zc;
}

}  // namespace nodruma::detail
