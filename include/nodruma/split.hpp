#pragma once

#include "nodruma/audio_buffer.hpp"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace nodruma {

/// Drum / percussion hit class from a groove split.
enum class HitKind { Kick, Snare, Hat, Unknown };

[[nodiscard]] inline const char* hit_kind_name(HitKind k) {
  switch (k) {
    case HitKind::Kick: return "kick";
    case HitKind::Snare: return "snare";
    case HitKind::Hat: return "hat";
    case HitKind::Unknown: return "unknown";
  }
  return "unknown";
}

struct SplitHit {
  std::int64_t onset_sample = 0;
  std::size_t start_sample = 0;   /// includes pre-roll
  std::size_t length_samples = 0;
  HitKind kind = HitKind::Unknown;
  float confidence = 0.f;  /// 0..1 classification confidence
  float centroid_hz = 0.f;
  float lf_ratio = 0.f;    /// ~40–160 Hz / total (attack window)
  float hf_ratio = 0.f;    /// ~2–10 kHz / total
};

struct SplitOptions {
  /// Multiplier on robust flux threshold (median + MAD, floored by P90).
  float threshold_scale = 1.0f;
  /// Minimum time between accepted onsets.
  float min_gap_sec = 0.048f;
  /// Max one-shot length (also capped by next onset).
  float max_hit_sec = 0.42f;
  /// Samples kept before the onset peak (attack headroom).
  float pre_roll_sec = 0.005f;
  /// STFT size at 44.1 kHz for flux (scaled with sample rate).
  int fft_size_44100 = 256;
  bool classify = true;
};

struct SplitResult {
  std::vector<SplitHit> hits;
  /// Per-sample spectral flux used for chopping (same length as input).
  std::vector<float> flux_samples;
};

/// Transient-based groove chop: STFT → spectral flux → dynamic threshold → segments.
/// Optionally classifies each hit as kick / snare / hat from attack spectra.
[[nodiscard]] SplitResult split_groove(const float* mono, std::size_t n, double sample_rate,
                                       const SplitOptions& opts = {});

[[nodiscard]] SplitResult split_groove(const AudioBuffer& input, const SplitOptions& opts = {});

/// Copy one hit from a multi-channel source into a mono (averaged) one-shot buffer.
[[nodiscard]] AudioBuffer extract_hit(const AudioBuffer& source, const SplitHit& hit);

/// Write `hits.json` + numbered WAVs under `out_dir`. Returns false on IO error.
[[nodiscard]] bool export_split(const AudioBuffer& source, const SplitResult& split,
                                const std::string& out_dir, const std::string& name_prefix = "");

}  // namespace nodruma
