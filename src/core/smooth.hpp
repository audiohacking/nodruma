#pragma once

#include <cstddef>
#include <vector>

namespace nodruma::detail {

enum class SmoothKernel { Gaussian, Exponential };

/// Symmetric sliding-window smoother (zero phase via centered window).
void adaptive_smooth(const float* in, float* out, std::size_t n,
                     SmoothKernel kernel, int base_radius,
                     float rate_sensitivity = 0.5f);

/// Cubic Hermite upsample from frame-rate series to sample-rate series.
void cubic_upsample(const float* frames, std::size_t num_frames, int hop,
                    float* samples, std::size_t num_samples);

}  // namespace nodruma::detail
