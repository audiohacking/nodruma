#include "onset.hpp"

#include "smooth.hpp"
#include "stft.hpp"

#include <algorithm>
#include <cmath>
#include <vector>

namespace nodruma::detail {

namespace {

/// Low-frequency kick score: favors the attack of a kick, not mid-body LF.
float lf_kick_score(const float* mono, std::size_t n, std::int64_t o, float sr) {
  if (!mono || n == 0 || o < 0 || static_cast<std::size_t>(o) >= n) return 0.f;
  const std::size_t start = static_cast<std::size_t>(o);
  const std::size_t win = std::min(n - start, static_cast<std::size_t>(sr * 0.055f));
  if (win < 32) return 0.f;

  const float a = std::exp(-2.f * 3.14159265f * 90.f / sr);
  auto lf_rms = [&](std::size_t from, std::size_t len) {
    float y = 0.f;
    double e = 0.0;
    const std::size_t end = std::min(n, from + len);
    for (std::size_t i = from; i < end; ++i) {
      y = (1.f - a) * mono[i] + a * y;
      e += static_cast<double>(y) * static_cast<double>(y);
    }
    const std::size_t used = end - from;
    return (used > 0) ? static_cast<float>(e / static_cast<double>(used)) : 0.f;
  };

  const float after = lf_rms(start, win);
  const std::size_t pre_n = std::min(start, static_cast<std::size_t>(sr * 0.035f));
  const float before = (pre_n > 16) ? lf_rms(start - pre_n, pre_n) : 0.f;
  // Contrast: kick attack rises into LF; mid-body candidates score lower.
  return after * after / (before + 0.08f * after + 1e-8f);
}

}  // namespace

OnsetResult detect_onsets(const float* mono, std::size_t n, double sample_rate,
                          int fft_size_44100, float threshold_scale) {
  OnsetResult result;
  if (n == 0) return result;

  const float sr = static_cast<float>(sample_rate);

  // Differentiate input to emphasize high-frequency changes.
  std::vector<float> diff(n, 0.f);
  diff[0] = mono[0];
  for (std::size_t i = 1; i < n; ++i) {
    diff[i] = mono[i] - mono[i - 1];
  }

  const StftConfig cfg = make_onset_stft_config(sample_rate, fft_size_44100);
  const StftData stft = compute_stft(diff.data(), n, sample_rate, cfg);

  result.flux_frames.assign(static_cast<std::size_t>(std::max(0, stft.num_frames)), 0.f);

  // Squared spectral flux: no frame normalization, no half-wave rectification.
  for (int f = 1; f < stft.num_frames; ++f) {
    float sum = 0.f;
    for (int b = 0; b < stft.num_bins; ++b) {
      const float a = stft.mag[static_cast<std::size_t>((f - 1) * stft.num_bins + b)];
      const float c = stft.mag[static_cast<std::size_t>(f * stft.num_bins + b)];
      const float d = c - a;
      sum += d * d;
    }
    result.flux_frames[static_cast<std::size_t>(f)] = sum;
  }

  std::vector<float> smoothed = result.flux_frames;
  if (!result.flux_frames.empty()) {
    adaptive_smooth(result.flux_frames.data(), smoothed.data(), result.flux_frames.size(),
                    SmoothKernel::Gaussian, 2, 0.4f);
    result.flux_frames = smoothed;
  }

  result.flux_samples.resize(n);
  cubic_upsample(result.flux_frames.data(), result.flux_frames.size(), cfg.hop,
                 result.flux_samples.data(), n);

  float mean = 0.f;
  for (float v : result.flux_samples) mean += v;
  mean /= static_cast<float>(std::max<std::size_t>(1, n));

  float var = 0.f;
  for (float v : result.flux_samples) {
    const float d = v - mean;
    var += d * d;
  }
  var /= static_cast<float>(std::max<std::size_t>(1, n));
  const float stddev = std::sqrt(var);
  const float thresh = mean + threshold_scale * (1.5f * stddev + 1e-12f);

  const int min_distance = static_cast<int>(sample_rate * 0.05);
  int last = -min_distance;
  for (std::size_t i = 1; i + 1 < n; ++i) {
    const float v = result.flux_samples[i];
    if (v > thresh && v >= result.flux_samples[i - 1] && v >= result.flux_samples[i + 1]) {
      if (static_cast<int>(i) - last >= min_distance) {
        result.onsets.push_back(static_cast<std::int64_t>(i));
        last = static_cast<int>(i);
      }
    }
  }

  if (result.onsets.empty()) {
    auto it = std::max_element(result.flux_samples.begin(), result.flux_samples.end());
    result.primary_onset = static_cast<std::int64_t>(
        std::distance(result.flux_samples.begin(), it));
    result.onsets.push_back(result.primary_onset);
  }

  // Also consider first amplitude attack and LF-envelope peak as kick candidates.
  // Flux alone picks hats/voice/silence ghosts (ils→silence, ifir→voice).
  {
    float peak = 1e-8f;
    for (std::size_t i = 0; i < n; ++i) peak = std::max(peak, std::fabs(mono[i]));
    const float gate = peak * 0.05f;
    for (std::size_t i = 0; i < n; ++i) {
      if (std::fabs(mono[i]) >= gate) {
        result.onsets.push_back(static_cast<std::int64_t>(i));
        break;
      }
    }

    // Peak of ~80 Hz envelope in the first 0.6 s (typical kick placement).
    const std::size_t scan_n = std::min(n, static_cast<std::size_t>(sr * 0.60f));
    const float a = std::exp(-2.f * 3.14159265f * 80.f / sr);
    float y = 0.f, env = 0.f, best_env = 0.f;
    std::int64_t best_i = 0;
    const float env_a = std::exp(-2.f * 3.14159265f * 25.f / sr);
    for (std::size_t i = 0; i < scan_n; ++i) {
      y = (1.f - a) * mono[i] + a * y;
      env = (1.f - env_a) * std::fabs(y) + env_a * env;
      if (env > best_env) {
        best_env = env;
        best_i = static_cast<std::int64_t>(i);
      }
    }
    if (best_i > 8) {
      // Walk back from LF peak to rising edge.
      std::vector<float> ae(static_cast<std::size_t>(best_i) + 1, 0.f);
      float z = 0.f;
      const float za = std::exp(-2.f * 3.14159265f * 40.f / sr);
      for (std::size_t i = 0; i <= static_cast<std::size_t>(best_i); ++i) {
        z = (1.f - za) * std::fabs(mono[i]) + za * z;
        ae[i] = z;
      }
      const float et = ae[static_cast<std::size_t>(best_i)] * 0.20f;
      std::int64_t att = best_i;
      while (att > 0 && ae[static_cast<std::size_t>(att)] > et) --att;
      result.onsets.push_back(att);
      result.onsets.push_back(best_i);
    }
  }

  // Primary = earliest strong LF-attack candidate (not mid-body LF peak — that
  // chopped npsr's beater by ~100 ms).
  {
    float max_s = 0.f;
    for (auto o : result.onsets) max_s = std::max(max_s, lf_kick_score(mono, n, o, sr));
    const float gate = max_s * 0.55f;
    std::int64_t best = result.onsets.front();
    float best_s = -1.f;
    for (auto o : result.onsets) {
      const float s = lf_kick_score(mono, n, o, sr);
      if (s < gate) continue;
      if (best_s < 0.f || o < best) {
        best = o;
        best_s = s;
      }
    }
    if (best_s < 0.f) {
      // Fallback: max score
      for (auto o : result.onsets) {
        const float s = lf_kick_score(mono, n, o, sr);
        if (s > best_s) {
          best_s = s;
          best = o;
        }
      }
    }
    result.primary_onset = best;
  }

  // Final snap: pull back to amplitude attack within 80 ms (preserve beater).
  {
    float peak = 1e-8f;
    const std::size_t lo = static_cast<std::size_t>(
        std::max<std::int64_t>(0, result.primary_onset - static_cast<std::int64_t>(sr * 0.08f)));
    const std::size_t hi = static_cast<std::size_t>(
        std::min<std::int64_t>(static_cast<std::int64_t>(n),
                               result.primary_onset + static_cast<std::int64_t>(sr * 0.02f)));
    for (std::size_t i = lo; i < hi; ++i) peak = std::max(peak, std::fabs(mono[i]));
    const float gate = peak * 0.08f;
    for (std::size_t i = lo; i < hi; ++i) {
      if (std::fabs(mono[i]) >= gate) {
        result.primary_onset = static_cast<std::int64_t>(i);
        break;
      }
    }
  }

  // Deduplicate onset list (keep primary first).
  {
    std::vector<std::int64_t> uniq;
    uniq.push_back(result.primary_onset);
    for (auto o : result.onsets) {
      if (std::abs(o - result.primary_onset) < min_distance) continue;
      bool seen = false;
      for (auto u : uniq) {
        if (std::abs(u - o) < min_distance) {
          seen = true;
          break;
        }
      }
      if (!seen) uniq.push_back(o);
    }
    result.onsets.swap(uniq);
  }

  return result;
}

}  // namespace nodruma::detail
