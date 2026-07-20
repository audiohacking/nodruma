#pragma once

#include <cstddef>
#include <vector>

namespace nodruma::detail {

/// JUCE-style TPT 2-pole state-variable lowpass (Butterworth-ish when Q≈0.707).
class TptLowpass {
public:
  void reset() {
    s1_ = 0.f;
    s2_ = 0.f;
  }

  /// Prime as if already settled on DC `x` (avoids cold-start smear at kick onset).
  void prime(float x) {
    s1_ = 0.f;
    s2_ = x;
  }

  void set_q(float q) { q_ = (q < 0.05f) ? 0.05f : q; }

  /// Process one sample. Uses live sample_rate (we intentionally fix the 44.1k hardcode quirk).
  float process(float x, float cutoff_hz, float sample_rate);

private:
  float s1_ = 0.f;
  float s2_ = 0.f;
  float q_ = 0.70710678f;  // 1/√2
};

/// Pitch-tracked multipass body cleanup + tail filters + lookahead limiter.
struct BodyCleanupConfig {
  int multipass = 3;  // isolation body; attack snap restored via envelope transfer
  float filter_q = 0.70710678f;
  float nyquist_clamp = 0.98f;
  float pitch_cutoff_ratio = 2.0f;  // reference body: min(2 × pitch, 0.98 × Nyquist)
  float tail_cut_a_hz = 7.5f;
  float tail_cut_b_hz = 40.f;
  float tail_q = 0.8f;
  /// Reference `applyTailFiltering(buf, sr, start, len)`: blend window starts ~90 ms after
  /// a nearby ZC and is only ~20 ms wide — NOT a whole-buffer tail wash.
  float tail_blend_start_sec = 0.09f;
  float tail_blend_len_sec = 0.02f;
  float limiter_lookahead_at_44100 = 2048.f;
  float limiter_release_ms = 10.f;
};

/// In-place cleanup of a mono kick region. `pitch_hz` must be same length as `io`.
void cleanup_kick_body(float* io, std::size_t n, const float* pitch_hz, double sample_rate,
                       const BodyCleanupConfig& cfg = {});

/// Lookahead peak limiter (per-channel mono buffer).
void lookahead_limit(float* io, std::size_t n, double sample_rate, float lookahead_at_44100 = 2048.f,
                     float release_ms = 10.f);

}  // namespace nodruma::detail
