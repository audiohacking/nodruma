#include "smooth.hpp"

#include <algorithm>
#include <cmath>
#include <vector>

namespace nodruma::detail {

namespace {

float kernel_weight(SmoothKernel kernel, int offset, int radius) {
  if (radius <= 0) return 1.f;
  const float x = static_cast<float>(offset) / static_cast<float>(radius);
  if (kernel == SmoothKernel::Gaussian) {
    return std::exp(-0.5f * x * x * 4.f);
  }
  // exponential decay from center
  return std::exp(-std::abs(x) * 2.5f);
}

}  // namespace

void adaptive_smooth(const float* in, float* out, std::size_t n, SmoothKernel kernel,
                     int base_radius, float rate_sensitivity) {
  if (n == 0) return;
  if (base_radius <= 0) {
    std::copy(in, in + n, out);
    return;
  }

  std::vector<float> deriv(n, 0.f);
  for (std::size_t i = 1; i + 1 < n; ++i) {
    deriv[i] = std::abs(in[i + 1] - in[i - 1]) * 0.5f;
  }
  float max_d = 1e-8f;
  for (float d : deriv) max_d = std::max(max_d, d);

  for (std::size_t i = 0; i < n; ++i) {
    const float rate = deriv[i] / max_d;
    int radius = static_cast<int>(std::lround(
        static_cast<float>(base_radius) * (1.f - rate_sensitivity * rate)));
    radius = std::max(1, radius);

    float sum_w = 0.f;
    float sum = 0.f;
    for (int k = -radius; k <= radius; ++k) {
      const std::size_t j = static_cast<std::size_t>(
          std::clamp(static_cast<int>(i) + k, 0, static_cast<int>(n) - 1));
      const float w = kernel_weight(kernel, k, radius);
      sum_w += w;
      sum += w * in[j];
    }
    out[i] = sum / std::max(sum_w, 1e-12f);
  }
}

void cubic_upsample(const float* frames, std::size_t num_frames, int hop, float* samples,
                    std::size_t num_samples) {
  if (num_frames == 0 || hop <= 0) {
    std::fill(samples, samples + num_samples, 0.f);
    return;
  }

  auto sample_at = [&](float frame_pos) -> float {
    const int i1 = static_cast<int>(std::floor(frame_pos));
    const float t = frame_pos - static_cast<float>(i1);
    const int i0 = std::max(0, i1 - 1);
    const int i2 = std::min(static_cast<int>(num_frames) - 1, i1 + 1);
    const int i3 = std::min(static_cast<int>(num_frames) - 1, i1 + 2);
    const int ii1 = std::clamp(i1, 0, static_cast<int>(num_frames) - 1);

    const float p0 = frames[i0];
    const float p1 = frames[ii1];
    const float p2 = frames[i2];
    const float p3 = frames[i3];

    // Catmull-Rom
    const float a = -0.5f * p0 + 1.5f * p1 - 1.5f * p2 + 0.5f * p3;
    const float b = p0 - 2.5f * p1 + 2.f * p2 - 0.5f * p3;
    const float c = -0.5f * p0 + 0.5f * p2;
    const float d = p1;
    return ((a * t + b) * t + c) * t + d;
  };

  for (std::size_t s = 0; s < num_samples; ++s) {
    const float frame_pos = static_cast<float>(s) / static_cast<float>(hop);
    samples[s] = sample_at(frame_pos);
  }
}

}  // namespace nodruma::detail
