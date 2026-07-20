#include "body_cleanup.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>
#include <vector>

namespace nodruma::detail {

namespace {
constexpr float kPi = std::numbers::pi_v<float>;

/// Reference multipass safety: hard clip to [-1, 1] (soft-knee waveshaping muddied the body).
float hard_clip(float x) { return std::clamp(x, -1.f, 1.f); }
}  // namespace

float TptLowpass::process(float x, float cutoff_hz, float sample_rate) {
  const float ny = 0.5f * sample_rate;
  const float fc = std::clamp(cutoff_hz, 1.f, ny * 0.99f);
  // TPT / trapezoidal SVF (JUCE StateVariableTPTFilter style)
  const float g = std::tan(kPi * fc / sample_rate);
  const float R = 1.f / q_;
  const float h = 1.f / (1.f + R * g + g * g);

  const float hp = h * (x - s1_ * (R + g) - s2_);
  const float bp = g * hp + s1_;
  const float lp = g * bp + s2_;
  s1_ = g * hp + bp;
  s2_ = g * bp + lp;
  return lp;
}

void lookahead_limit(float* io, std::size_t n, double sample_rate, float lookahead_at_44100,
                     float release_ms) {
  if (!io || n == 0 || sample_rate <= 0.0) return;
  const int look = std::max(
      1, static_cast<int>(std::lround(sample_rate * static_cast<double>(lookahead_at_44100) / 44100.0)));
  const float release_coeff =
      std::exp(-1.f / (static_cast<float>(sample_rate) * (release_ms * 0.001f)));
  constexpr float kCeiling = 0.94f;

  float env = 1.f;
  for (std::size_t i = 0; i < n; ++i) {
    float peak = 1e-8f;
    const std::size_t end = std::min(n, i + static_cast<std::size_t>(look));
    for (std::size_t j = i; j < end; ++j) peak = std::max(peak, std::fabs(io[j]));
    float target = 1.f;
    if (peak > kCeiling) target = kCeiling / peak;
    if (target < env)
      env = target;
    else
      env = release_coeff * env + (1.f - release_coeff) * target;
    io[i] = hard_clip(io[i] * env);
  }
}

void cleanup_kick_body(float* io, std::size_t n, const float* pitch_hz, double sample_rate,
                       const BodyCleanupConfig& cfg) {
  if (!io || !pitch_hz || n == 0 || sample_rate <= 0.0) return;
  const float sr = static_cast<float>(sample_rate);
  const float nyquist = 0.5f * sr;

  // Preserve dry input for attack-envelope transfer (snap without HF mush).
  std::vector<float> dry_in(io, io + n);

  // Multipass pitch-tracked LPF (reference: hard-clip before each pass)
  for (int pass = 0; pass < cfg.multipass; ++pass) {
    for (std::size_t i = 0; i < n; ++i) io[i] = hard_clip(io[i]);
    TptLowpass flt;
    flt.set_q(cfg.filter_q);
    flt.prime(io[0]);
    for (std::size_t i = 0; i < n; ++i) {
      const float t = static_cast<float>(i) / sr;
      const float pitch = std::max(1.f, pitch_hz[i]);
      const float open = 700.f * std::exp(-t * 40.f);
      const float cut = std::min(cfg.pitch_cutoff_ratio * pitch + open,
                                 cfg.nyquist_clamp * nyquist);
      io[i] = flt.process(io[i], cut, sr);
    }
  }

  // Tail filters (fixed 7.5 Hz + 40 Hz), raised-cosine blend only in a short window.
  std::vector<float> dry(io, io + n);
  std::vector<float> wet(n);
  for (std::size_t i = 0; i < n; ++i) wet[i] = dry[i];

  {
    TptLowpass a;
    a.set_q(cfg.tail_q);
    a.prime(wet[0]);
    for (std::size_t i = 0; i < n; ++i) wet[i] = a.process(wet[i], cfg.tail_cut_a_hz, sr);
    TptLowpass b;
    b.set_q(cfg.tail_q);
    b.prime(wet[0]);
    for (std::size_t i = 0; i < n; ++i) wet[i] = b.process(wet[i], cfg.tail_cut_b_hz, sr);
  }

  const std::size_t blend0 =
      std::min(n, static_cast<std::size_t>(cfg.tail_blend_start_sec * sr));
  const std::size_t blend_n =
      std::max<std::size_t>(1, static_cast<std::size_t>(cfg.tail_blend_len_sec * sr));
  for (std::size_t i = 0; i < n; ++i) {
    if (i < blend0 || i >= blend0 + blend_n) {
      io[i] = dry[i];
      continue;
    }
    const float x = static_cast<float>(i - blend0) / static_cast<float>(blend_n);
    const float blend = (std::cos(x * kPi) + 1.f) * 0.5f;
    io[i] = wet[i] * (1.f - blend) + dry[i] * blend;
  }

  // Snap = dry beater on cleaned body when the region looks kick-like.
  // Skip / attenuate if early energy is mid/voice-heavy (ifir) or noise.
  {
    const std::size_t probe = std::min(n, static_cast<std::size_t>(0.040f * sr));
    float lf_e = 0.f, bb_e = 0.f;
    float y = 0.f;
    const float a = std::exp(-2.f * kPi * 120.f / sr);
    for (std::size_t i = 0; i < probe; ++i) {
      y = (1.f - a) * dry_in[i] + a * y;
      lf_e += y * y;
      bb_e += dry_in[i] * dry_in[i];
    }
    const float lf_ratio = lf_e / (bb_e + 1e-12f);
    // Kick attacks are LF-dominant after mild LP; voice/hats are not.
    const float click_g = std::clamp((lf_ratio - 0.15f) / 0.35f, 0.f, 1.f) * 0.88f;

    if (click_g > 0.02f) {
      const std::size_t click_n = std::min(n, static_cast<std::size_t>(0.028f * sr));
      const std::size_t hold_n = std::min(click_n, static_cast<std::size_t>(0.012f * sr));
      for (std::size_t i = 0; i < click_n; ++i) {
        float ce = 1.f;
        if (i >= hold_n) {
          const float x = static_cast<float>(i - hold_n) / static_cast<float>(click_n - hold_n);
          ce = 0.5f + 0.5f * std::cos(x * kPi);
        }
        io[i] += dry_in[i] * click_g * ce;
      }

      const std::size_t snap_n = std::min(n, static_cast<std::size_t>(0.035f * sr));
      const float env_a = std::exp(-2.f * kPi * 100.f / sr);
      float er = 0.f, ef = 0.f;
      for (std::size_t i = 0; i < snap_n; ++i) {
        er = (1.f - env_a) * std::fabs(dry_in[i]) + env_a * er;
        ef = (1.f - env_a) * std::fabs(io[i]) + env_a * ef;
        float s = er / (ef + 1e-6f);
        s = std::clamp(s, 0.85f, 1.8f);
        const float w = 1.f - static_cast<float>(i) / static_cast<float>(snap_n);
        io[i] *= 1.f + (s - 1.f) * w * click_g;
      }
    }
  }

  float peak = 0.f;
  for (std::size_t i = 0; i < n; ++i) {
    io[i] = hard_clip(io[i]);
    peak = std::max(peak, std::fabs(io[i]));
  }
  if (peak > 0.98f) {
    const float g = 0.98f / peak;
    for (std::size_t i = 0; i < n; ++i) io[i] *= g;
  }
}

}  // namespace nodruma::detail
