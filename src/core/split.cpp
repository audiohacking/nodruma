#include "nodruma/split.hpp"

#include "nodruma/wav_io.hpp"

#include "smooth.hpp"
#include "stft.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <numbers>
#include <sstream>

namespace nodruma {

namespace {

constexpr float kPi = std::numbers::pi_v<float>;

std::vector<float> to_mono_vec(const AudioBuffer& buf) {
  std::vector<float> mono;
  buf.to_mono(mono);
  return mono;
}

/// General drum-break onsets: squared spectral flux + dynamic threshold.
/// Unlike kick detect, does NOT bias toward LF / primary kick.
void detect_transients(const float* mono, std::size_t n, double sample_rate,
                       const SplitOptions& opts, std::vector<std::int64_t>& onsets,
                       std::vector<float>& flux_samples) {
  onsets.clear();
  flux_samples.assign(n, 0.f);
  if (!mono || n < 64 || sample_rate <= 0.0) return;

  const float sr = static_cast<float>(sample_rate);

  // Pad leading silence so hits that start at sample 0 still produce flux.
  const std::size_t pad = static_cast<std::size_t>(sr * 0.025f);
  std::vector<float> padded(pad + n, 0.f);
  std::copy(mono, mono + n, padded.begin() + static_cast<std::ptrdiff_t>(pad));
  const float* x = padded.data();
  const std::size_t xn = padded.size();

  // Emphasize HF changes (classic HFC / transient cue) via pre-emphasis + diff.
  std::vector<float> pre(xn);
  pre[0] = x[0];
  for (std::size_t i = 1; i < xn; ++i) {
    const float hp = x[i] - 0.95f * x[i - 1];
    pre[i] = hp - (i > 1 ? (x[i - 1] - 0.95f * x[i - 2]) : 0.f);
  }

  const detail::StftConfig cfg =
      detail::make_onset_stft_config(sample_rate, opts.fft_size_44100);
  const detail::StftData stft = detail::compute_stft(pre.data(), xn, sample_rate, cfg);

  std::vector<float> flux_frames(static_cast<std::size_t>(std::max(0, stft.num_frames)), 0.f);
  for (int f = 1; f < stft.num_frames; ++f) {
    float hfc = 0.f;
    float lfc = 0.f;
    // Dual flux: HFC for snares/hats, LF for kicks.
    for (int b = 0; b < stft.num_bins; ++b) {
      const float a = stft.mag[static_cast<std::size_t>((f - 1) * stft.num_bins + b)];
      const float c = stft.mag[static_cast<std::size_t>(f * stft.num_bins + b)];
      const float d2 = (c - a) * (c - a);
      const float frac = static_cast<float>(b) / static_cast<float>(std::max(1, stft.num_bins - 1));
      hfc += d2 * (0.35f + 0.65f * frac);
      lfc += d2 * (1.0f - 0.75f * frac);
    }
    flux_frames[static_cast<std::size_t>(f)] = hfc + 0.85f * lfc;
  }

  std::vector<float> smoothed = flux_frames;
  if (!flux_frames.empty()) {
    detail::adaptive_smooth(flux_frames.data(), smoothed.data(), flux_frames.size(),
                            detail::SmoothKernel::Gaussian, 2, 0.4f);
  }

  std::vector<float> flux_padded(xn, 0.f);
  detail::cubic_upsample(smoothed.data(), smoothed.size(), cfg.hop, flux_padded.data(), xn);
  // Expose flux aligned to original (unpadded) timeline.
  for (std::size_t i = 0; i < n; ++i) flux_samples[i] = flux_padded[pad + i];

  // Robust threshold on frame-rate flux: mean+σ is wrecked by one loud hit on loops.
  // Use max(median + scale·1.5·1.4826·MAD, scale·0.35·P90).
  std::vector<float> sorted = smoothed;
  std::sort(sorted.begin(), sorted.end());
  const auto pct = [&](float p) -> float {
    if (sorted.empty()) return 0.f;
    const float idx = p * static_cast<float>(sorted.size() - 1);
    const std::size_t i0 = static_cast<std::size_t>(idx);
    const std::size_t i1 = std::min(i0 + 1, sorted.size() - 1);
    const float t = idx - static_cast<float>(i0);
    return sorted[i0] * (1.f - t) + sorted[i1] * t;
  };
  const float median = pct(0.5f);
  const float p90 = pct(0.90f);
  std::vector<float> absdev(smoothed.size());
  for (std::size_t i = 0; i < smoothed.size(); ++i)
    absdev[i] = std::fabs(smoothed[i] - median);
  std::sort(absdev.begin(), absdev.end());
  const float mad =
      absdev.empty() ? 0.f
                     : absdev[absdev.size() / 2] * 1.4826f;  // ≈σ for Gaussian
  const float thresh =
      std::max(median + opts.threshold_scale * (1.5f * mad + 1e-12f),
               opts.threshold_scale * 0.35f * p90);

  // Peak-pick at frame rate, then map to samples (cleaner than upsampled local-max).
  const int min_frames =
      std::max(1, static_cast<int>(opts.min_gap_sec * sr / static_cast<float>(cfg.hop)));
  int last = -min_frames;
  for (std::size_t f = 1; f + 1 < smoothed.size(); ++f) {
    const float v = smoothed[f];
    if (v > thresh && v >= smoothed[f - 1] && v >= smoothed[f + 1]) {
      if (static_cast<int>(f) - last >= min_frames) {
        const std::int64_t sample_padded =
            static_cast<std::int64_t>(f) * static_cast<std::int64_t>(cfg.hop);
        const std::int64_t sample = sample_padded - static_cast<std::int64_t>(pad);
        if (sample >= 0 && sample < static_cast<std::int64_t>(n)) {
          onsets.push_back(sample);
          last = static_cast<int>(f);
        }
      }
    }
  }

  // Snap each onset back a few ms to the local amplitude attack.
  for (auto& o : onsets) {
    const std::size_t hi = static_cast<std::size_t>(o);
    const std::size_t lo = static_cast<std::size_t>(
        std::max<std::int64_t>(0, o - static_cast<std::int64_t>(sr * 0.012f)));
    float peak = 1e-8f;
    for (std::size_t i = lo; i <= hi && i < n; ++i) peak = std::max(peak, std::fabs(mono[i]));
    const float gate = peak * 0.12f;
    for (std::size_t i = lo; i <= hi && i < n; ++i) {
      if (std::fabs(mono[i]) >= gate) {
        o = static_cast<std::int64_t>(i);
        break;
      }
    }
  }

  // Files that open on a hit can still miss the first attack — seed it
  // from amplitude if the head is strong and no onset is nearby.
  {
    float global_peak = 1e-8f;
    for (std::size_t i = 0; i < n; ++i) global_peak = std::max(global_peak, std::fabs(mono[i]));
    const std::size_t head_n = std::min(n, static_cast<std::size_t>(sr * 0.05f));
    float head_peak = 1e-8f;
    for (std::size_t i = 0; i < head_n; ++i) head_peak = std::max(head_peak, std::fabs(mono[i]));
    if (head_peak > 0.35f * global_peak) {
      const float gate = head_peak * 0.12f;
      std::int64_t head_onset = 0;
      for (std::size_t i = 0; i < head_n; ++i) {
        if (std::fabs(mono[i]) >= gate) {
          head_onset = static_cast<std::int64_t>(i);
          break;
        }
      }
      const int min_distance = std::max(1, static_cast<int>(opts.min_gap_sec * sr));
      bool near = false;
      for (auto o : onsets) {
        if (std::llabs(o - head_onset) < min_distance) {
          near = true;
          break;
        }
      }
      if (!near) {
        onsets.insert(onsets.begin(), head_onset);
        std::sort(onsets.begin(), onsets.end());
      }
    }
  }
}

struct BandFeat {
  float centroid_hz = 0.f;
  float sub = 0.f;  /// ~30–80 Hz
  float lf = 0.f;   /// ~40–160 Hz
  float mid = 0.f;  /// ~200–2000 Hz
  float hf = 0.f;   /// ~2–12 kHz
  float air = 0.f;  /// ~6–16 kHz
  float total = 0.f;
};

/// Attack spectrum from onset (not pre-roll). Single windowed FFT — short STFT
/// from start_sample was missing kick LF and over-labeling snares.
BandFeat attack_bands(const float* mono, std::size_t n, std::int64_t onset,
                      double sample_rate) {
  BandFeat f;
  if (!mono || n < 16 || sample_rate <= 0.0) return f;
  const float sr = static_cast<float>(sample_rate);
  const std::size_t o =
      static_cast<std::size_t>(std::clamp<std::int64_t>(onset, 0, static_cast<std::int64_t>(n) - 1));
  // ~80 ms of post-onset audio (kick body needs more than a click window).
  const std::size_t want = static_cast<std::size_t>(sr * 0.08f);
  const std::size_t avail = n - o;
  const std::size_t use = std::min(want, avail);
  if (use < 64) return f;

  detail::StftConfig cfg;
  cfg.fft_size = 1024;
  cfg.hop = 512;
  if (sample_rate > 0.0) {
    const double scale = sample_rate / 44100.0;
    cfg.fft_size = std::max(256, static_cast<int>(std::lround(1024 * scale)));
    cfg.hop = std::max(128, cfg.fft_size / 2);
  }
  const detail::StftData stft = detail::compute_stft(mono + o, use, sample_rate, cfg);
  if (stft.num_frames < 1 || stft.num_bins < 2) return f;

  double e_sub = 0, e_lf = 0, e_mid = 0, e_hf = 0, e_air = 0, e_tot = 0, wsum = 0, fsum = 0;
  const int frames = std::min(stft.num_frames, 4);
  for (int fr = 0; fr < frames; ++fr) {
    for (int b = 0; b < stft.num_bins; ++b) {
      const float mag = stft.mag[static_cast<std::size_t>(fr * stft.num_bins + b)];
      const double p = static_cast<double>(mag) * mag;
      const float hz = static_cast<float>(b) * sr / static_cast<float>(stft.fft_size);
      e_tot += p;
      fsum += p * hz;
      wsum += p;
      if (hz >= 30.f && hz < 80.f) e_sub += p;
      if (hz >= 40.f && hz < 160.f) e_lf += p;
      if (hz >= 200.f && hz < 2000.f) e_mid += p;
      if (hz >= 2000.f && hz < 12000.f) e_hf += p;
      if (hz >= 6000.f && hz < 16000.f) e_air += p;
    }
  }
  f.total = static_cast<float>(e_tot + 1e-18);
  f.sub = static_cast<float>(e_sub / (e_tot + 1e-18));
  f.lf = static_cast<float>(e_lf / (e_tot + 1e-18));
  f.mid = static_cast<float>(e_mid / (e_tot + 1e-18));
  f.hf = static_cast<float>(e_hf / (e_tot + 1e-18));
  f.air = static_cast<float>(e_air / (e_tot + 1e-18));
  f.centroid_hz = (wsum > 1e-18) ? static_cast<float>(fsum / wsum) : 0.f;
  return f;
}

void classify_hit(SplitHit& hit, const float* mono, std::size_t n, double sample_rate) {
  if (hit.start_sample >= n) return;
  const BandFeat b = attack_bands(mono, n, hit.onset_sample, sample_rate);
  hit.centroid_hz = b.centroid_hz;
  hit.lf_ratio = b.lf;
  hit.hf_ratio = b.hf;

  // Soft scores (sub-bass is the strongest kick cue on mixed breaks).
  float kick_s = b.sub * 2.2f + b.lf * 1.6f + (1.f - std::min(b.centroid_hz / 500.f, 1.f)) * 0.7f -
                 b.hf * 0.9f - b.air * 1.4f;
  float snare_s = b.mid * 0.85f + b.hf * 0.85f +
                  std::clamp((b.centroid_hz - 500.f) / 2500.f, 0.f, 1.f) * 0.45f - b.sub * 1.8f -
                  b.lf * 0.7f;
  float hat_s = b.hf * 1.2f + b.air * 1.8f +
                std::clamp((b.centroid_hz - 2500.f) / 4000.f, 0.f, 1.f) - b.lf * 1.5f - b.sub * 2.f -
                b.mid * 0.15f;

  // Hard vetoes — stop kicks landing on snare when click/mid masks the body.
  if (b.sub > 0.12f && b.lf > 0.12f && b.air < 0.18f) {
    kick_s += 1.5f;
    snare_s -= 0.8f;
  }
  if (b.lf > 0.22f && b.hf < 0.22f) {
    kick_s += 1.2f;
    snare_s -= 0.6f;
  }
  if (b.sub > 0.18f) {
    kick_s += 1.0f;
  }
  if (b.air > 0.35f || (b.hf > 0.55f && b.lf < 0.05f)) {
    hat_s += 1.2f;
    kick_s -= 0.8f;
  }

  float best = kick_s;
  HitKind kind = HitKind::Kick;
  if (snare_s > best) {
    best = snare_s;
    kind = HitKind::Snare;
  }
  if (hat_s > best) {
    best = hat_s;
    kind = HitKind::Hat;
  }

  const float second = (kind == HitKind::Kick)
                           ? std::max(snare_s, hat_s)
                           : (kind == HitKind::Snare ? std::max(kick_s, hat_s)
                                                    : std::max(kick_s, snare_s));
  const float margin = best - second;

  // Prefer kick on tight races when any real LF/sub is present.
  if (margin < 0.08f && (b.lf > 0.15f || b.sub > 0.08f) && b.air < 0.25f) {
    kind = HitKind::Kick;
    best = kick_s;
  }

  hit.kind = (best > 0.12f && (margin > 0.04f || kind == HitKind::Kick)) ? kind : HitKind::Unknown;
  hit.confidence = std::clamp(0.35f + margin * 0.9f + std::max(0.f, best) * 0.2f, 0.f, 1.f);
}

}  // namespace

SplitResult split_groove(const float* mono, std::size_t n, double sample_rate,
                         const SplitOptions& opts) {
  SplitResult out;
  if (!mono || n == 0 || sample_rate <= 0.0) return out;

  const float sr = static_cast<float>(sample_rate);
  std::vector<std::int64_t> onsets;
  detect_transients(mono, n, sample_rate, opts, onsets, out.flux_samples);
  if (onsets.empty()) return out;

  const std::size_t max_len = std::max<std::size_t>(64, static_cast<std::size_t>(opts.max_hit_sec * sr));
  const std::size_t pre = static_cast<std::size_t>(opts.pre_roll_sec * sr);

  for (std::size_t hi = 0; hi < onsets.size(); ++hi) {
    SplitHit hit;
    hit.onset_sample = onsets[hi];
    const std::size_t onset = static_cast<std::size_t>(std::max<std::int64_t>(0, onsets[hi]));
    hit.start_sample = (onset > pre) ? (onset - pre) : 0;

    std::size_t end = n;
    if (hi + 1 < onsets.size()) {
      end = static_cast<std::size_t>(std::max<std::int64_t>(0, onsets[hi + 1]));
    }
    end = std::min(end, hit.start_sample + max_len);
    if (end <= hit.start_sample) end = std::min(n, hit.start_sample + max_len);
    hit.length_samples = end - hit.start_sample;

    // Trim trailing near-silence inside the slice (keep a little tail).
    {
      float peak = 1e-8f;
      for (std::size_t i = 0; i < hit.length_samples; ++i)
        peak = std::max(peak, std::fabs(mono[hit.start_sample + i]));
      const float thr = peak * 0.02f;
      std::size_t last = hit.length_samples;
      for (std::size_t i = hit.length_samples; i > 0; --i) {
        if (std::fabs(mono[hit.start_sample + i - 1]) >= thr) {
          last = i;
          break;
        }
      }
      const std::size_t pad = static_cast<std::size_t>(sr * 0.012f);
      hit.length_samples = std::min(hit.length_samples, last + pad);
    }

    if (opts.classify) classify_hit(hit, mono, n, sample_rate);
    out.hits.push_back(hit);
  }
  return out;
}

SplitResult split_groove(const AudioBuffer& input, const SplitOptions& opts) {
  const auto mono = to_mono_vec(input);
  return split_groove(mono.data(), mono.size(), input.sample_rate(), opts);
}

AudioBuffer extract_hit(const AudioBuffer& source, const SplitHit& hit) {
  if (source.empty() || hit.length_samples == 0) return {};
  std::vector<float> mono;
  source.to_mono(mono);
  if (hit.start_sample >= mono.size()) return {};
  const std::size_t n = std::min(hit.length_samples, mono.size() - hit.start_sample);

  // Short raised-cosine fades to avoid clicks at chop boundaries.
  const float sr = static_cast<float>(source.sample_rate());
  const std::size_t fade = std::min(n / 4, static_cast<std::size_t>(sr * 0.003f));
  std::vector<float> out(n);
  for (std::size_t i = 0; i < n; ++i) {
    float g = 1.f;
    if (fade > 0 && i < fade) {
      const float x = static_cast<float>(i) / static_cast<float>(fade);
      g = 0.5f - 0.5f * std::cos(x * kPi);
    } else if (fade > 0 && i + fade >= n) {
      const float x = static_cast<float>(n - i) / static_cast<float>(fade);
      g = 0.5f - 0.5f * std::cos(std::clamp(x, 0.f, 1.f) * kPi);
    }
    out[i] = mono[hit.start_sample + i] * g;
  }
  return AudioBuffer::from_mono(out, source.sample_rate()).to_stereo();
}

bool export_split(const AudioBuffer& source, const SplitResult& split, const std::string& out_dir,
                  const std::string& name_prefix) {
  namespace fs = std::filesystem;
  std::error_code ec;
  fs::create_directories(out_dir, ec);
  if (ec) return false;

  const std::string prefix = name_prefix.empty() ? "" : (name_prefix + "_");
  std::ostringstream json;
  json << "{\n  \"sample_rate\": " << source.sample_rate() << ",\n  \"num_hits\": "
       << split.hits.size() << ",\n  \"hits\": [\n";

  for (std::size_t i = 0; i < split.hits.size(); ++i) {
    const auto& h = split.hits[i];
    char num[32];
    std::snprintf(num, sizeof(num), "%03zu", i);
    const std::string base =
        std::string(num) + "_" + hit_kind_name(h.kind);
    const std::string wav_name = prefix + base + ".wav";
    const fs::path wav_path = fs::path(out_dir) / wav_name;

    AudioBuffer one = extract_hit(source, h);
    if (one.empty() || !save_wav(wav_path.string(), one)) return false;

    json << "    {\"index\": " << i << ", \"file\": \"" << wav_name
         << "\", \"kind\": \"" << hit_kind_name(h.kind) << "\", \"confidence\": " << h.confidence
         << ", \"onset_sample\": " << h.onset_sample << ", \"start_sample\": " << h.start_sample
         << ", \"length_samples\": " << h.length_samples << ", \"centroid_hz\": " << h.centroid_hz
         << ", \"lf_ratio\": " << h.lf_ratio << ", \"hf_ratio\": " << h.hf_ratio << "}";
    if (i + 1 < split.hits.size()) json << ",";
    json << "\n";
  }
  json << "  ]\n}\n";

  std::ofstream jf(fs::path(out_dir) / (prefix + "hits.json"));
  if (!jf) return false;
  jf << json.str();
  return true;
}

}  // namespace nodruma
