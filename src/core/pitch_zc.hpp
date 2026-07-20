#pragma once

#include <cstddef>
#include <vector>

namespace nodruma::detail {

/// Half-cycle widths (samples) from zero-crossing pitch tracking on a kick region.
/// Adaptive acceptance band rejects noise crossings on non-sine kicks.
[[nodiscard]] std::vector<int> measure_halfcycle_widths(const float* samples, std::size_t start,
                                                        std::size_t end, int ref_period_samples);

/// Sample-and-hold frequency envelope: freqHz = sampleRate / (2 * width), held for `width` samples.
/// Output length = sum of widths (may be shorter than input region).
[[nodiscard]] std::vector<float> frequency_envelope_from_widths(const std::vector<int>& widths,
                                                               double sample_rate);

/// Expand a step frequency contour to exactly `out_len` samples (pad/hold last).
void expand_frequency_envelope(const std::vector<float>& step_freq, std::vector<float>& out,
                               std::size_t out_len, float fill_hz);

/// Autocorr fundamental estimate in [min_hz, max_hz] on a kick body region (typically LP'd).
[[nodiscard]] float estimate_kick_fundamental_hz(const float* samples, std::size_t n, double sample_rate,
                                                 float min_hz = 28.f, float max_hz = 120.f);

/// Fold / replace a ZC pitch contour so it sits near `anchor_hz` (fixes octave errors & ZC blow-ups).
void anchor_pitch_envelope(std::vector<float>& pitch_hz, float anchor_hz, float min_hz = 28.f,
                           float max_hz = 140.f);

/// Append mean(last, prev) half-cycle width `extra_count` times to extend decay.
/// so the pitch contour continues through the decaying tail (default 4 when “extra decay” is on).
void extend_decay_widths(std::vector<int>& widths, int extra_count = 4);

/// Prefix-sum of half-cycle widths → absolute zero-crossing sample indices (first width is first ZC).
[[nodiscard]] std::vector<int> widths_to_crossing_indices(const std::vector<int>& widths);

}  // namespace nodruma::detail
