#include "synth.hpp"

#include "body_cleanup.hpp"
#include "pitch_zc.hpp"
#include "smooth.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <numbers>
#include <vector>

namespace nodruma::detail {

namespace {

constexpr float kPi = std::numbers::pi_v<float>;

void one_pole_hp(const float* in, float* out, std::size_t n, float cutoff_hz, float sr) {
  const float a = std::exp(-2.f * kPi * cutoff_hz / sr);
  float y = 0.f;
  float prev = 0.f;
  for (std::size_t i = 0; i < n; ++i) {
    y = a * (y + in[i] - prev);
    prev = in[i];
    out[i] = y;
  }
}

void one_pole_lp(const float* in, float* out, std::size_t n, float cutoff_hz, float sr) {
  const float a = std::exp(-2.f * kPi * cutoff_hz / sr);
  float y = 0.f;
  for (std::size_t i = 0; i < n; ++i) {
    y = (1.f - a) * in[i] + a * y;
    out[i] = y;
  }
}

std::vector<float> abs_env(const float* x, std::size_t n, int radius) {
  std::vector<float> a(n), out(n);
  for (std::size_t i = 0; i < n; ++i) a[i] = std::fabs(x[i]);
  adaptive_smooth(a.data(), out.data(), n, SmoothKernel::Exponential, radius, 0.25f);
  return out;
}

float eval_user_env(const SegmentEnvelope& env, float t, float fallback) {
  if (env.points.empty()) return fallback;
  return env.evaluate(t);
}

std::vector<float> extract_body_wavetable(const float* body, std::size_t n, float period_samples) {
  std::vector<float> wt;
  const int period = std::clamp(static_cast<int>(std::lround(period_samples)), 8, 2048);
  if (static_cast<int>(n) < period * 2) return wt;

  // Prefer a cycle shortly after the attack peak (skip the click spike).
  std::size_t peak_i = 0;
  float peak = 0.f;
  const std::size_t search = std::min(n, static_cast<std::size_t>(period * 8));
  for (std::size_t i = 0; i < search; ++i) {
    const float a = std::fabs(body[i]);
    if (a > peak) {
      peak = a;
      peak_i = i;
    }
  }
  std::size_t start = peak_i + static_cast<std::size_t>(period / 4);
  if (start + static_cast<std::size_t>(period) >= n)
    start = (peak_i > static_cast<std::size_t>(period)) ? peak_i - static_cast<std::size_t>(period / 2)
                                                         : 0;

  // Snap start to a rising zero-crossing when possible.
  for (std::size_t i = start; i + 1 < n && i < start + static_cast<std::size_t>(period); ++i) {
    if (body[i] <= 0.f && body[i + 1] > 0.f) {
      start = i;
      break;
    }
  }
  if (start + static_cast<std::size_t>(period) > n) return wt;

  wt.resize(static_cast<std::size_t>(period));
  float wpeak = 1e-8f;
  double mean = 0.0;
  for (int i = 0; i < period; ++i) {
    wt[static_cast<std::size_t>(i)] = body[start + static_cast<std::size_t>(i)];
    mean += wt[static_cast<std::size_t>(i)];
  }
  mean /= static_cast<double>(period);
  for (float& v : wt) {
    v = static_cast<float>(static_cast<double>(v) - mean);  // kill DC → sub-20 Hz mud
    wpeak = std::max(wpeak, std::fabs(v));
  }
  for (float& v : wt) v /= wpeak;
  return wt;
}

void analyze_kick(AnalysisCache& cache, const IModel& model, const float* mono, std::size_t n) {
  const float sr = static_cast<float>(cache.sample_rate);
  const int o = static_cast<int>(
      std::clamp<std::int64_t>(cache.onset.primary_onset, 0, static_cast<std::int64_t>(n)));
  const std::size_t region_n = (o < static_cast<int>(n)) ? (n - static_cast<std::size_t>(o)) : 0;
  if (region_n < 64) {
    cache.valid = false;
    return;
  }

  const float expected_min_hz = std::max(20.f, model.pitch_min_hz() * 0.75f);
  const int ref_period = std::max(1, static_cast<int>(sr / expected_min_hz));
  const float fallback_hz = 0.5f * (model.pitch_min_hz() + model.pitch_max_hz());

  std::vector<float> raw_region(region_n);
  for (std::size_t i = 0; i < region_n; ++i) raw_region[i] = mono[static_cast<std::size_t>(o) + i];

  // --- Preliminaries: region, pitch seed, cleanup order ---
  // 1) Mild LP → ZC widths → sample-and-hold pitch (for Stage-3 cutoff tracking)
  std::vector<float> zc_src(region_n);
  one_pole_lp(raw_region.data(), zc_src.data(), region_n, 400.f, sr);

  auto widths = measure_halfcycle_widths(zc_src.data(), 0, region_n, ref_period);
  auto step_freq = frequency_envelope_from_widths(widths, cache.sample_rate);
  std::vector<float> pitch_region;
  expand_frequency_envelope(step_freq, pitch_region, region_n, fallback_hz);

  float anchor_hz = 55.f;
  {
    std::vector<float> deep(region_n);
    one_pole_lp(zc_src.data(), deep.data(), region_n, 80.f, sr);
    const float est =
        estimate_kick_fundamental_hz(deep.data(), region_n, cache.sample_rate, 28.f, 110.f);
    if (est > 1.f) anchor_hz = est;
  }
  anchor_pitch_envelope(pitch_region, anchor_hz, 28.f, 180.f);
  // Pull toward body pitch, but keep early pitch HIGH so Stage-3 cutoff opens
  // for the attack (snap). The old 42–68 Hz clamp locked cut≈110 Hz and smeared
  // the transient into a soft camel-chew body.
  for (std::size_t i = 0; i < region_n; ++i) {
    const float t = static_cast<float>(i) / sr;
    const float pull = 1.f - std::exp(-t * 10.f);
    float f = pitch_region[i];
    f += (anchor_hz - f) * pull;
    const float hi = 160.f * std::exp(-t * 22.f) + std::min(72.f, anchor_hz * 1.35f);
    const float lo = std::max(36.f, anchor_hz * 0.75f);
    f = std::clamp(f, lo, hi);
    pitch_region[i] = f;
  }
  {
    std::vector<float> sp(region_n);
    adaptive_smooth(pitch_region.data(), sp.data(), region_n, SmoothKernel::Exponential, 48, 0.35f);
    pitch_region.swap(sp);
  }

  // 2) Stage-3 multipass + tail + limiter on a working copy (isolation path).
  //    Peak widths are measured *after* this; cleaned amp also drives the keep-gate.
  std::vector<float> isolated(raw_region);
  cleanup_kick_body(isolated.data(), region_n, pitch_region.data(), cache.sample_rate);

  // Early tail prep in reference starts ~90 ms after a nearby ZC with ~20 ms fade — approximate
  // by zeroing obvious post-kick energy later via the length/gate path.

  // 3) Re-measure widths on cleaned audio, then applyExtraDecayPeaks (append mean of last 2 × 4).
  {
    auto clean_widths = measure_halfcycle_widths(isolated.data(), 0, region_n, ref_period);
    if (clean_widths.size() >= 2) {
      extend_decay_widths(clean_widths, 4);
      auto step2 = frequency_envelope_from_widths(clean_widths, cache.sample_rate);
      expand_frequency_envelope(step2, pitch_region, region_n, fallback_hz);
      anchor_pitch_envelope(pitch_region, anchor_hz, 28.f, 180.f);
      for (std::size_t i = 0; i < region_n; ++i) {
        const float t = static_cast<float>(i) / sr;
        const float pull = 1.f - std::exp(-t * 10.f);
        float f = pitch_region[i];
        f += (anchor_hz - f) * pull;
        const float hi = 160.f * std::exp(-t * 22.f) + std::min(72.f, anchor_hz * 1.35f);
        const float lo = std::max(36.f, anchor_hz * 0.75f);
        f = std::clamp(f, lo, hi);
        pitch_region[i] = f;
      }
      std::vector<float> sp(region_n);
      adaptive_smooth(pitch_region.data(), sp.data(), region_n, SmoothKernel::Exponential, 48, 0.35f);
      pitch_region.swap(sp);
    }
  }

  // Click from original HF
  std::vector<float> full_click(n, 0.f);
  {
    std::vector<float> hp(n);
    one_pole_hp(mono, hp.data(), n, 3000.f, sr);
    auto ce = abs_env(hp.data(), n, 10);
    float cpeak = 1e-8f;
    for (int i = o; i < std::min(static_cast<int>(n), o + static_cast<int>(sr * 0.04f)); ++i)
      cpeak = std::max(cpeak, ce[static_cast<std::size_t>(i)]);
    for (std::size_t i = 0; i < n; ++i) {
      if (static_cast<int>(i) < o) continue;
      full_click[i] = ce[i] / cpeak;
    }
  }

  auto raw_amp = abs_env(raw_region.data(), region_n, 12);
  auto iso_amp = abs_env(isolated.data(), region_n, 14);

  float amp_peak = 1e-8f;
  std::size_t peak_i = 0;
  const std::size_t peak_search = std::min(region_n, static_cast<std::size_t>(sr * 0.14f));
  for (std::size_t i = 0; i < peak_search; ++i) {
    if (raw_amp[i] > amp_peak) {
      amp_peak = raw_amp[i];
      peak_i = i;
    }
  }

  float iso_peak = 1e-8f;
  std::size_t iso_peak_i = peak_i;
  for (std::size_t i = 0; i < peak_search; ++i) {
    if (iso_amp[i] > iso_peak) {
      iso_peak = iso_amp[i];
      iso_peak_i = i;
    }
  }

  // Kick decay: fit a longer window so long tails (obs/eh) aren't killed by a
  // steep early half-life. Cap decay so exp envelope can last ~250–400 ms.
  float decay_per_sec = 8.f;
  {
    const std::size_t i0 = iso_peak_i;
    std::size_t i1 = i0;
    const std::size_t i_cap =
        std::min(region_n - 1, i0 + static_cast<std::size_t>(sr * 0.22f));
    const float target = iso_peak * 0.35f;
    for (std::size_t i = i0 + 1; i <= i_cap; ++i) {
      i1 = i;
      if (iso_amp[i] <= target) break;
    }
    if (i1 <= i0 + 4)
      i1 = std::min(region_n - 1, i0 + static_cast<std::size_t>(sr * 0.10f));
    if (i1 > i0 + 4 && iso_amp[i1] > 1e-6f && iso_amp[i0] > iso_amp[i1]) {
      const float dt = static_cast<float>(i1 - i0) / sr;
      const float ratio = iso_amp[i1] / iso_amp[i0];
      decay_per_sec = std::clamp(-std::log(std::max(ratio, 1e-4f)) / dt, 4.f, 14.f);
    }
  }

  // LF of raw — used for long-tail env + length (Stage-3 can under-represent sustains).
  std::vector<float> lf_raw(region_n);
  one_pole_lp(raw_region.data(), lf_raw.data(), region_n, 70.f, sr);
  auto lf_amp = abs_env(lf_raw.data(), region_n, 20);
  float lf_peak = 1e-8f;
  for (std::size_t i = 0; i < peak_search; ++i) lf_peak = std::max(lf_peak, lf_amp[i]);

  std::vector<float> kick_env(region_n, 0.f);
  {
    const float t_peak = static_cast<float>(iso_peak_i) / sr;
    for (std::size_t i = 0; i < region_n; ++i) {
      const float t = static_cast<float>(i) / sr;
      if (i <= iso_peak_i) {
        kick_env[i] = std::max(iso_amp[i], lf_amp[i]);
      } else {
        const float pred = iso_peak * std::exp(-(t - t_peak) * decay_per_sec);
        // Prefer cleaned amp; use raw LF to hold long sustains Stage-3 under-represents.
        // Non-rising pass below stops mix-bed re-attacks from lifting the envelope.
        const float meas = std::max(iso_amp[i], lf_amp[i] * 0.88f);
        kick_env[i] = std::max(pred, meas);
      }
    }
    // Never let the keep-envelope rise after settle — blocks mix-bed re-attacks
    // (npsr) without forcing long sustains (obs/eh) to die early.
    {
      const std::size_t settle =
          std::min(region_n - 1, iso_peak_i + static_cast<std::size_t>(sr * 0.080f));
      for (std::size_t i = settle + 1; i < region_n; ++i) {
        if (kick_env[i] > kick_env[i - 1]) kick_env[i] = kick_env[i - 1];
      }
    }
  }

  std::size_t kick_len = region_n;
  {
    const std::size_t min_len =
        std::min(region_n, iso_peak_i + static_cast<std::size_t>(sr * 0.18f));
    const std::size_t max_len =
        std::min(region_n, iso_peak_i + static_cast<std::size_t>(sr * 0.55f));
    const float thr = iso_peak * 0.018f;

    kick_len = max_len;
    for (std::size_t i = min_len; i < max_len; ++i) {
      // Length follows shaped kick env only (not raw LF — that re-opens mix beds).
      if (kick_env[i] < thr) {
        kick_len = i;
        break;
      }
    }

    {
      const std::size_t start = iso_peak_i + static_cast<std::size_t>(sr * 0.12f);
      float prev = raw_amp[std::min(start, region_n - 1)];
      for (std::size_t i = start; i < kick_len; ++i) {
        const float d = raw_amp[i] - prev;
        prev = raw_amp[i];
        const float mid = std::max(0.f, raw_amp[i] - lf_amp[i]);
        const bool loud = raw_amp[i] > amp_peak * 0.22f && raw_amp[i] > kick_env[i] * 5.f;
        const bool sharp = d > amp_peak * 0.05f;
        const bool not_bass = mid > amp_peak * 0.06f;  // ignore pure-LF sustains/beds
        if (loud && sharp && not_bass) {
          kick_len = std::max(min_len, i - static_cast<std::size_t>(sr * 0.008f));
          break;
        }
      }
    }
    kick_len = std::clamp(kick_len, min_len, max_len);
  }
  cache.kick_length_samples = kick_len;

  // Export = Stage-3 cleaned body. Snap is attack crest + clean
  // 80–320 Hz body — NOT additive HF/shell layers (those sounded like crushed MP3).
  // Preserve pre-peak samples fully; decay-gate only after the peak to kill the bed.
  std::vector<float> export_body(region_n, 0.f);
  {
    const std::size_t fade_n = std::min(kick_len, static_cast<std::size_t>(sr * 0.045f));
    const float t_peak = static_cast<float>(iso_peak_i) / sr;

    std::vector<float> lf_tail(kick_len);
    for (std::size_t i = 0; i < kick_len; ++i) lf_tail[i] = lf_raw[i];

    for (std::size_t i = 0; i < kick_len; ++i) {
      float y = isolated[i];
      if (i > iso_peak_i) {
        const float t = static_cast<float>(i) / sr;
        const float keep =
            std::clamp(kick_env[i] / (iso_peak + 1e-8f), 0.f, 1.f);
        const float w = std::clamp((t - t_peak) / 0.06f, 0.f, 1.f);
        y *= (1.f - w) + w * keep;

        // Fill missing LF sustain from LP(raw), gated by keep (non-rising env
        // keeps this from rebuilding mix beds after the kick has dropped).
        const float iso_n = std::fabs(isolated[i]);
        const float target = keep * iso_peak;
        if (iso_n < target) {
          y += lf_tail[i] * ((target - iso_n) / (iso_peak + 1e-8f)) * 0.90f;
        }
      }
      if (fade_n > 0 && i + fade_n >= kick_len) {
        const float x = static_cast<float>(kick_len - i) / static_cast<float>(fade_n);
        y *= 0.5f - 0.5f * std::cos(std::clamp(x, 0.f, 1.f) * kPi);
      }
      export_body[i] = y;
    }

    // Intelligent low-end: measure how light the body is vs a kick target, then
    // add adaptive boom/sub shelves (skip the first ~10 ms so attack stays snappy).
    {
      std::vector<float> boom(kick_len), sub(kick_len), deep(kick_len);
      one_pole_lp(export_body.data(), boom.data(), kick_len, 75.f, sr);
      one_pole_lp(export_body.data(), sub.data(), kick_len, 45.f, sr);
      one_pole_lp(export_body.data(), deep.data(), kick_len, 32.f, sr);

      double body_e = 0.0, boom_e = 0.0;
      const std::size_t m0 = std::min(kick_len, static_cast<std::size_t>(sr * 0.015f));
      const std::size_t m1 = std::min(kick_len, static_cast<std::size_t>(sr * 0.120f));
      for (std::size_t i = m0; i < m1; ++i) {
        body_e += static_cast<double>(export_body[i]) * export_body[i];
        boom_e += static_cast<double>(boom[i]) * boom[i];
      }
      const float boom_frac = static_cast<float>(boom_e / (body_e + 1e-12));
      // Target ~0.5–0.85 of body energy under ~75 Hz for a solid kick.
      const float target = 0.70f;
      const float deficit = std::clamp(target - boom_frac, 0.f, 0.60f);
      const float boom_g = 0.32f + 1.10f * deficit;
      const float sub_g = 0.14f + 0.65f * deficit;
      const float deep_g = 0.08f + 0.42f * deficit;

      for (std::size_t i = 0; i < kick_len; ++i) {
        const float t = static_cast<float>(i) / sr;
        const float boom_w = std::clamp((t - 0.010f) / 0.025f, 0.f, 1.f);
        // Slight extra weight mid-body where "low-end feel" lives
        const float body_w = boom_w * (0.75f + 0.25f * std::exp(-std::max(0.f, t - 0.04f) * 8.f));
        export_body[i] +=
            boom[i] * boom_g * body_w + sub[i] * sub_g * body_w + deep[i] * deep_g * body_w;
      }
    }

    // Peak normalize only — no soft-knee waveshaper
    {
      float peak = 1e-8f;
      for (std::size_t i = 0; i < kick_len; ++i) peak = std::max(peak, std::fabs(export_body[i]));
      if (peak > 0.95f) {
        const float g = 0.95f / peak;
        for (std::size_t i = 0; i < kick_len; ++i) export_body[i] *= g;
      }
    }
  }

  std::vector<float> power_amp(region_n);
  float power_peak = 1e-8f;
  for (std::size_t i = 0; i < region_n; ++i) {
    float a = (i < kick_len) ? kick_env[i] : 0.f;
    power_amp[i] = a;
    power_peak = std::max(power_peak, a);
  }

  {
    float f_att = pitch_region[std::min(region_n - 1, static_cast<std::size_t>(sr * 0.01f))];
    f_att = std::clamp(f_att, 30.f, 200.f);
    cache.body_wavetable = extract_body_wavetable(export_body.data(), kick_len, sr / f_att);
  }

  cache.foundation_amp.assign(n, 0.f);
  cache.tone_amp.assign(n, 0.f);
  cache.transient_amp.assign(n, 0.f);
  cache.noise_amp.assign(n, 0.f);
  cache.perc_noise_amp.assign(n, 0.f);
  cache.foundation_pitch_hz.assign(n, pitch_region.empty() ? fallback_hz : pitch_region.front());

  for (std::size_t i = 0; i < region_n; ++i) {
    const std::size_t gi = static_cast<std::size_t>(o) + i;
    if (i >= kick_len) continue;
    const float a = power_amp[i] / power_peak;
    cache.foundation_amp[gi] = a;
    cache.tone_amp[gi] = a;
    cache.foundation_pitch_hz[gi] = pitch_region[i];
    cache.transient_amp[gi] = full_click[gi];
    cache.perc_noise_amp[gi] = full_click[gi];
  }
  const float p0 = cache.foundation_pitch_hz[static_cast<std::size_t>(o)];
  for (int i = 0; i < o; ++i) cache.foundation_pitch_hz[static_cast<std::size_t>(i)] = p0;

  KickVoiceParams& kv = cache.kick;
  kv = KickVoiceParams{};
  float f0 = p0;
  if (kick_len > 8) {
    f0 = *std::max_element(pitch_region.begin(),
                           pitch_region.begin() + std::min<std::size_t>(kick_len / 10 + 1, kick_len));
  }
  kv.base_hz = std::clamp(anchor_hz, 45.f, 62.f);
  kv.sweep_hz = std::clamp(std::max(0.f, f0 - kv.base_hz), 0.f, 40.f);
  kv.sweep_decay = 28.f;
  kv.length_sec = static_cast<float>(kick_len) / sr;
  kv.attack = std::clamp(cache.transient_amp[static_cast<std::size_t>(o)] /
                             (cache.foundation_amp[static_cast<std::size_t>(o)] + 1e-4f),
                         0.05f, 0.95f);
  kv.harmonic = 0.04f;
  kv.sub_level = 0.0f;
  kv.drive = 2.4f;
  kv.valid = true;

  auto to_buf_region = [&](const std::vector<float>& region, std::size_t len) {
    AudioBuffer b(n, 1, cache.sample_rate);
    for (std::size_t i = 0; i < len && static_cast<std::size_t>(o) + i < n; ++i)
      b.channel(0)[static_cast<std::size_t>(o) + i] = region[i];
    return b;
  };
  cache.layers.foundation = to_buf_region(export_body, kick_len);
  cache.layers.tone = cache.layers.foundation;
  {
    AudioBuffer tr(n, 1, cache.sample_rate);
    for (std::size_t i = 0; i < n; ++i) tr.channel(0)[i] = full_click[i] * 0.5f;
    cache.layers.transient = tr;
    cache.layers.perc_noise = tr;
  }
  cache.layers.noise = AudioBuffer(n, 1, cache.sample_rate);
  {
    AudioBuffer res(n, 1, cache.sample_rate);
    for (std::size_t i = 0; i < kick_len; ++i) {
      const std::size_t gi = static_cast<std::size_t>(o) + i;
      res.channel(0)[gi] = mono[gi] - export_body[i];
    }
    cache.layers.residue = res;
  }

  cache.valid = true;
}

AudioBuffer resynthesize_kick(const AnalysisCache& cache, const ModelParams& params) {
  const std::size_t n = cache.num_frames;
  const float sr = static_cast<float>(cache.sample_rate);
  const int o = static_cast<int>(
      std::clamp<std::int64_t>(cache.onset.primary_onset, 0, static_cast<std::int64_t>(n)));

  // Export the isolated Stage-3 cleaned body (not a sine rebuild).
  if (!cache.valid || cache.layers.foundation.num_frames() != n) {
    return AudioBuffer(n, 2, cache.sample_rate);
  }

  const float* body = cache.layers.foundation.channel(0);
  const std::size_t kick_len =
      cache.kick_length_samples > 0
          ? std::min(cache.kick_length_samples, n - static_cast<std::size_t>(std::max(o, 0)))
          : (n - static_cast<std::size_t>(std::max(o, 0)));

  AudioBuffer out(n, 2, cache.sample_rate);
  out.clear();

  std::vector<float> mono_out(n, 0.f);
  const std::size_t fade_n = std::min(kick_len, static_cast<std::size_t>(sr * 0.02f));
  const float body_g = std::max(0.05f, params.foundation_gain);

  for (std::size_t i = 0; i < n; ++i) {
    const int ti = static_cast<int>(i) - o;
    if (ti < 0 || static_cast<std::size_t>(ti) >= kick_len) continue;

    const float t_abs = static_cast<float>(i) / sr;
    const float t = static_cast<float>(ti) / sr;

    float y = body[i] * body_g;
    y *= eval_user_env(params.foundation_env, t_abs, 1.f);

    if (t > 0.f && params.body_decay != 1.f) {
      const float t2 = t / std::max(params.body_decay, 0.25f);
      const int j = o + static_cast<int>(t2 * sr);
      if (j >= o && j < o + static_cast<int>(kick_len))
        y = body[static_cast<std::size_t>(j)] * body_g *
            eval_user_env(params.foundation_env, t_abs, 1.f);
      else if (j >= o + static_cast<int>(kick_len))
        y = 0.f;
    }

    if (fade_n > 0 && static_cast<std::size_t>(ti) + fade_n >= kick_len) {
      const float x =
          static_cast<float>(kick_len - static_cast<std::size_t>(ti)) / static_cast<float>(fade_n);
      y *= std::clamp(x, 0.f, 1.f);
    }

    mono_out[i] = y;
  }

  // Match reference export: peak normalize + hard clip (no soft-knee mush).
  float peak = 1e-8f;
  for (float v : mono_out) peak = std::max(peak, std::fabs(v));
  float g = std::max(0.05f, params.output_gain);
  if (peak > 0.95f) g *= 0.95f / peak;
  for (std::size_t i = 0; i < n; ++i) {
    const float y = std::clamp(mono_out[i] * g, -1.f, 1.f);
    out.channel(0)[i] = y;
    out.channel(1)[i] = y;
  }

  return out;
}

/// Snap primary onset to the amplitude attack (one-shot chops from split already
/// start near the hit; kick-biased detect can still miss HF-only hats/snares).
void snap_primary_attack(AnalysisCache& cache, const float* mono, std::size_t n) {
  if (!mono || n == 0) return;
  const float sr = static_cast<float>(cache.sample_rate);
  std::size_t peak_i = 0;
  float peak = 0.f;
  for (std::size_t i = 0; i < n; ++i) {
    const float a = std::fabs(mono[i]);
    if (a > peak) {
      peak = a;
      peak_i = i;
    }
  }
  if (peak < 1e-6f) return;
  const float gate = peak * 0.12f;
  const std::size_t lo = (peak_i > static_cast<std::size_t>(sr * 0.03f))
                             ? (peak_i - static_cast<std::size_t>(sr * 0.03f))
                             : 0;
  std::int64_t onset = static_cast<std::int64_t>(peak_i);
  for (std::size_t i = lo; i <= peak_i; ++i) {
    if (std::fabs(mono[i]) >= gate) {
      onset = static_cast<std::int64_t>(i);
      break;
    }
  }
  cache.onset.primary_onset = onset;
  if (cache.onset.onsets.empty()) cache.onset.onsets.push_back(onset);
}

void window_layer(AudioBuffer& buf, std::int64_t onset, std::size_t len, float sr) {
  if (buf.empty() || len == 0) return;
  const std::size_t n = buf.num_frames();
  const std::size_t o = static_cast<std::size_t>(std::max<std::int64_t>(0, onset));
  const std::size_t fade = std::min(len / 5, static_cast<std::size_t>(sr * 0.008f));
  for (std::size_t c = 0; c < buf.num_channels(); ++c) {
    float* x = buf.channel(c);
    for (std::size_t i = 0; i < n; ++i) {
      if (i < o || i >= o + len) {
        x[i] = 0.f;
        continue;
      }
      const std::size_t ti = i - o;
      if (fade > 0 && ti + fade >= len) {
        const float u =
            static_cast<float>(len - ti) / static_cast<float>(fade);
        x[i] *= 0.5f - 0.5f * std::cos(std::clamp(u, 0.f, 1.f) * kPi);
      }
    }
  }
}

void fill_layer_amps(AnalysisCache& cache) {
  auto fill = [&](const AudioBuffer& buf, std::vector<float>& dest) {
    if (buf.empty()) {
      dest.assign(cache.num_frames, 0.f);
      return;
    }
    dest = abs_env(buf.channel(0), buf.num_frames(), 64);
  };
  fill(cache.layers.foundation, cache.foundation_amp);
  fill(cache.layers.tone, cache.tone_amp);
  fill(cache.layers.noise, cache.noise_amp);
  fill(cache.layers.transient, cache.transient_amp);
  fill(cache.layers.perc_noise, cache.perc_noise_amp);
}

std::size_t estimate_event_length(const float* mono, std::size_t n, std::int64_t onset, float sr,
                                  float min_sec, float max_sec, float floor_frac) {
  const std::size_t o = static_cast<std::size_t>(std::max<std::int64_t>(0, onset));
  if (o >= n) return static_cast<std::size_t>(min_sec * sr);
  const std::size_t max_len =
      std::min(n - o, static_cast<std::size_t>(max_sec * sr));
  const std::size_t min_len = std::min(max_len, static_cast<std::size_t>(min_sec * sr));
  auto env = abs_env(mono + o, max_len, 48);
  float peak = 1e-8f;
  for (float v : env) peak = std::max(peak, v);
  const float thr = peak * floor_frac;
  std::size_t last = min_len;
  for (std::size_t i = 0; i < env.size(); ++i) {
    if (env[i] >= thr) last = i + 1;
  }
  return std::clamp(last, min_len, max_len);
}

/// Inject band-shaped noise when STFT noise layer is thin (common on short chops).
void boost_noise_layer(AudioBuffer& noise, const float* mono, std::size_t n, float sr,
                       float hp_hz, float amount) {
  if (noise.num_frames() != n || !mono || amount <= 0.f) return;
  std::vector<float> hp(n), env;
  one_pole_hp(mono, hp.data(), n, hp_hz, sr);
  env = abs_env(hp.data(), n, 32);
  float epeak = 1e-8f;
  for (float v : env) epeak = std::max(epeak, v);
  float npeak = 1e-8f;
  for (std::size_t i = 0; i < n; ++i) npeak = std::max(npeak, std::fabs(noise.channel(0)[i]));
  // Only fill if extracted noise is much quieter than input HF.
  if (npeak > 0.2f * epeak) return;

  // Cap injection so quiet hats aren't inflated past the source HF peak.
  const float cap = epeak * amount;
  std::uint32_t rng = 0xC0FFEEU ^ static_cast<std::uint32_t>(n);
  float lp = 0.f;
  const float a = std::exp(-2.f * kPi * (hp_hz * 4.f) / sr);
  for (std::size_t i = 0; i < n; ++i) {
    rng = rng * 1664525u + 1013904223u;
    const float white = (static_cast<float>(rng >> 8) / 16777216.f) * 2.f - 1.f;
    lp = (1.f - a) * white + a * lp;
    const float g = (env[i] / epeak) * cap;
    noise.channel(0)[i] += lp * g;
  }
}

void analyze_snare(AnalysisCache& cache, const IModel& model, const float* mono, std::size_t n) {
  (void)model;
  if (!mono || n == 0) return;
  const float sr = static_cast<float>(cache.sample_rate);
  snap_primary_attack(cache, mono, n);
  const std::int64_t o = cache.onset.primary_onset;

  // Keep STFT layers from extract; reinforce wire/noise if thin.
  if (cache.layers.noise.num_frames() == n)
    boost_noise_layer(cache.layers.noise, mono, n, sr, 1200.f, 0.55f);
  if (cache.layers.perc_noise.num_frames() == n)
    boost_noise_layer(cache.layers.perc_noise, mono, n, sr, 3000.f, 0.35f);

  const std::size_t len =
      estimate_event_length(mono, n, o, sr, 0.07f, 0.28f, 0.025f);
  cache.kick_length_samples = len;

  window_layer(cache.layers.transient, o, len, sr);
  window_layer(cache.layers.foundation, o, len, sr);
  window_layer(cache.layers.tone, o, len, sr);
  window_layer(cache.layers.noise, o, len, sr);
  window_layer(cache.layers.perc_noise, o, len, sr);

  fill_layer_amps(cache);
  cache.foundation_pitch_hz.assign(n, 180.f);
  cache.valid = true;
}

void analyze_hat(AnalysisCache& cache, const IModel& model, const float* mono, std::size_t n) {
  (void)model;
  if (!mono || n == 0) return;
  const float sr = static_cast<float>(cache.sample_rate);
  snap_primary_attack(cache, mono, n);
  const std::int64_t o = cache.onset.primary_onset;

  // Kill LF bleed on foundation/tone for hats.
  auto hp_buf = [&](AudioBuffer& buf, float cut) {
    if (buf.num_frames() != n) return;
    std::vector<float> tmp(n);
    one_pole_hp(buf.channel(0), tmp.data(), n, cut, sr);
    std::copy(tmp.begin(), tmp.end(), buf.channel(0));
  };
  hp_buf(cache.layers.foundation, 1500.f);
  hp_buf(cache.layers.tone, 2000.f);
  hp_buf(cache.layers.noise, 2500.f);
  hp_buf(cache.layers.perc_noise, 4000.f);
  hp_buf(cache.layers.transient, 3000.f);

  if (cache.layers.noise.num_frames() == n)
    boost_noise_layer(cache.layers.noise, mono, n, sr, 4000.f, 0.45f);
  if (cache.layers.perc_noise.num_frames() == n)
    boost_noise_layer(cache.layers.perc_noise, mono, n, sr, 6000.f, 0.3f);

  const std::size_t len =
      estimate_event_length(mono, n, o, sr, 0.018f, 0.09f, 0.03f);
  cache.kick_length_samples = len;

  window_layer(cache.layers.transient, o, len, sr);
  window_layer(cache.layers.foundation, o, len, sr);
  window_layer(cache.layers.tone, o, len, sr);
  window_layer(cache.layers.noise, o, len, sr);
  window_layer(cache.layers.perc_noise, o, len, sr);

  fill_layer_amps(cache);
  cache.foundation_pitch_hz.assign(n, 800.f);
  cache.valid = true;
}

AudioBuffer resynthesize_layers(const AnalysisCache& cache, const ModelParams& params) {
  const std::size_t n = cache.num_frames;
  const float sr = static_cast<float>(cache.sample_rate);
  if (!cache.valid || n == 0) return AudioBuffer(0, 2, cache.sample_rate);

  const int o = static_cast<int>(
      std::clamp<std::int64_t>(cache.onset.primary_onset, 0, static_cast<std::int64_t>(n)));
  const std::size_t ev_len =
      cache.kick_length_samples > 0
          ? std::min(cache.kick_length_samples, n - static_cast<std::size_t>(std::max(o, 0)))
          : (n - static_cast<std::size_t>(std::max(o, 0)));

  auto layer_at = [&](const AudioBuffer& buf, std::size_t i) -> float {
    if (buf.num_frames() != n || buf.empty()) return 0.f;
    return buf.channel(0)[i];
  };

  AudioBuffer out(n, 2, cache.sample_rate);
  out.clear();
  std::vector<float> mono(n, 0.f);
  const float width = std::clamp(params.stereo_width, 0.f, 0.5f);

  for (std::size_t i = 0; i < n; ++i) {
    const int ti = static_cast<int>(i) - o;
    if (ti < 0 || static_cast<std::size_t>(ti) >= ev_len) continue;
    const float t_abs = static_cast<float>(i) / sr;

    float y = 0.f;
    y += layer_at(cache.layers.transient, i) * params.transient_gain *
         eval_user_env(params.transient_env, t_abs, 1.f);
    y += layer_at(cache.layers.foundation, i) * params.foundation_gain *
         eval_user_env(params.foundation_env, t_abs, 1.f);
    y += layer_at(cache.layers.tone, i) * params.tone_gain *
         eval_user_env(params.tone_env, t_abs, 1.f);
    y += layer_at(cache.layers.noise, i) * params.noise_gain *
         eval_user_env(params.noise_env, t_abs, 1.f);
    y += layer_at(cache.layers.perc_noise, i) * params.perc_noise_gain *
         eval_user_env(params.perc_noise_env, t_abs, 1.f);
    if (params.residue_gain != 0.f)
      y += layer_at(cache.layers.residue, i) * params.residue_gain;

    if (params.body_decay != 1.f && ti > 0) {
      const float t = static_cast<float>(ti) / sr;
      const float scale = std::exp(-t * (1.f - std::clamp(params.body_decay, 0.15f, 2.f)) * 8.f);
      y *= scale;
    }
    mono[i] = y;
  }

  float peak = 1e-8f;
  for (float v : mono) peak = std::max(peak, std::fabs(v));
  // Attenuate only if clipping — don't inflate quiet hats to 0 dBFS.
  float g = std::max(0.05f, params.output_gain);
  if (peak > 0.95f) g *= 0.95f / peak;

  for (std::size_t i = 0; i < n; ++i) {
    const float y = std::clamp(mono[i] * g, -1.f, 1.f);
    out.channel(0)[i] = y * (1.f - width);
    out.channel(1)[i] = y * (1.f + width);
  }
  return out;
}

}  // namespace

void match_envelopes(AnalysisCache& cache, const IModel& model, const float* mono,
                     std::size_t n) {
  if (n == 0 || mono == nullptr) return;
  cache.num_frames = n;
  if (model.id() == "snare") {
    analyze_snare(cache, model, mono, n);
  } else if (model.id() == "hat") {
    analyze_hat(cache, model, mono, n);
  } else {
    analyze_kick(cache, model, mono, n);
  }
}

AudioBuffer resynthesize(const AnalysisCache& cache, const IModel& model,
                         const ModelParams& params) {
  if (!cache.valid || cache.num_frames == 0) return AudioBuffer(0, 2, cache.sample_rate);
  if (model.id() == "snare" || model.id() == "hat") {
    return resynthesize_layers(cache, params);
  }
  return resynthesize_kick(cache, params);
}

}  // namespace nodruma::detail
