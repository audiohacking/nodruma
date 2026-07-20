#pragma once

#include <array>
#include <cstddef>
#include <string>
#include <vector>

namespace nodruma {

/// Multi-segment envelope breakpoint (time/value/slope — slope reserved for shaping).
struct EnvelopeBreakpoint {
  float time = 0.f;   // seconds relative to region start
  float value = 0.f;
  float slope = 0.f;  // per-segment slope (0 = linear lerp between points)
};

struct SegmentEnvelope {
  std::vector<EnvelopeBreakpoint> points;

  [[nodiscard]] float evaluate(float t_seconds) const;
  void set_constant(float value);
  void set_adsr(float attack, float decay, float sustain, float release, float peak = 1.f);
};

/// User-facing / morphable synthesis controls for a session.
struct ModelParams {
  float transient_gain = 1.f;
  float foundation_gain = 1.f;
  float tone_gain = 1.f;
  float noise_gain = 1.f;
  float perc_noise_gain = 1.f;
  float residue_gain = 0.f;

  float foundation_pitch_scale = 1.f;  // multiply tracked pitch
  float tone_brightness = 1.f;        // high partial emphasis
  float noise_brightness = 1.f;       // noise band center shift
  float attack_tighten = 1.f;         // <1 shorter attack, >1 longer
  float body_decay = 1.f;             // envelope time scale
  float stereo_width = 0.15f;
  float output_gain = 1.f;

  SegmentEnvelope transient_env;
  SegmentEnvelope foundation_env;
  SegmentEnvelope tone_env;
  SegmentEnvelope noise_env;
  SegmentEnvelope perc_noise_env;

  void reset_defaults();
};

/// Simple JSON-ish load/save (minimal subset, no external JSON lib).
[[nodiscard]] bool params_to_json(const ModelParams& p, std::string& out);
[[nodiscard]] bool params_from_json(const std::string& json, ModelParams& out);

}  // namespace nodruma
