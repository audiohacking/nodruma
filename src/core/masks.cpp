// Soft-mask helpers used by extract (kept as a TU for future shared use).
#include "nodruma/model.hpp"

#include <algorithm>
#include <cmath>

namespace nodruma::detail {

float soft_band_weight(float freq_hz, const BandPrior& prior) {
  const float width = std::max(prior.high_hz - prior.low_hz, 1.f);
  const float edge = width * std::max(prior.softness, 0.05f);
  if (freq_hz < prior.low_hz) {
    const float d = (prior.low_hz - freq_hz) / std::max(edge, 1.f);
    return std::exp(-d * d);
  }
  if (freq_hz > prior.high_hz) {
    const float d = (freq_hz - prior.high_hz) / std::max(edge, 1.f);
    return std::exp(-d * d);
  }
  const float x = (freq_hz - prior.center_hz) / (0.5f * width);
  return std::exp(-x * x * 0.5f);
}

}  // namespace nodruma::detail
