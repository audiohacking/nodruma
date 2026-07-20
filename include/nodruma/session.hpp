#pragma once

#include "nodruma/audio_buffer.hpp"
#include "nodruma/model.hpp"
#include "nodruma/params.hpp"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace nodruma {

struct OnsetResult {
  std::vector<float> flux_frames;       // per STFT hop
  std::vector<float> flux_samples;      // upsampled to sample rate
  std::vector<std::int64_t> onsets;     // sample indices
  std::int64_t primary_onset = 0;
};

struct LayerBuffers {
  AudioBuffer transient;
  AudioBuffer foundation;
  AudioBuffer tone;
  AudioBuffer noise;
  AudioBuffer perc_noise;
  AudioBuffer residue;

  [[nodiscard]] AudioBuffer& get(LayerId id);
  [[nodiscard]] const AudioBuffer& get(LayerId id) const;
};

/// Parametric kick voice. Analysis fits these; resynthesis renders a clean
/// synth — not filtered mix residue.
struct KickVoiceParams {
  float base_hz = 55.f;       // resting pitch
  float sweep_hz = 140.f;     // initial pitch offset above base
  float sweep_decay = 45.f;   // fastExpDecay rate for main sweep
  float sweep_decay2 = 8.f;   // slower secondary sweep component
  float amp_decay = 2.5f;     // amplitude exp decay rate
  float attack = 0.55f;       // 0..1 click / brightness (tone)
  float decay = 0.55f;        // 0..1 length (inverse of amp tightness)
  float sub_level = 0.36f;
  float harmonic = 0.19f;     // 2nd partial mix
  float click_noise = 0.25f;
  float click_tone = 0.15f;
  float drive = 1.7f;
  float length_sec = 0.55f;
  bool valid = false;
};

/// Cached envelopes / pitch tracks for fast morph (resynth-only).
struct AnalysisCache {
  OnsetResult onset;
  LayerBuffers layers;
  KickVoiceParams kick;
  std::vector<float> foundation_pitch_hz;  // debug / morph viz
  std::vector<float> foundation_amp;
  std::vector<float> tone_amp;
  std::vector<float> noise_amp;
  std::vector<float> transient_amp;
  std::vector<float> perc_noise_amp;
  /// One period of isolated body (peak-normalized) for wavetable resynth.
  std::vector<float> body_wavetable;
  /// Kick event length from primary onset (samples); output is silent after this.
  std::size_t kick_length_samples = 0;
  double sample_rate = 44100.0;
  std::size_t num_frames = 0;
  bool valid = false;
};

class Session {
public:
  Session();
  ~Session();

  Session(const Session&) = delete;
  Session& operator=(const Session&) = delete;
  Session(Session&&) noexcept;
  Session& operator=(Session&&) noexcept;

  void set_model(std::unique_ptr<IModel> model);
  [[nodiscard]] const IModel* model() const;

  void set_params(const ModelParams& params);
  [[nodiscard]] ModelParams params() const;

  void set_input(AudioBuffer input);
  [[nodiscard]] const AudioBuffer& input() const;

  [[nodiscard]] const AnalysisCache& cache() const;
  [[nodiscard]] AnalysisCache& cache();

  /// Binary session dump for morph CLI (simple format).
  [[nodiscard]] bool save_cache(const std::string& path) const;
  [[nodiscard]] bool load_cache(const std::string& path);

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace nodruma
