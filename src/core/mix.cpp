#include "mix.hpp"

#include <algorithm>
#include <cmath>

namespace nodruma::detail {

AudioBuffer mix_layers(const std::vector<AudioBuffer>& layers, const std::vector<float>& gains,
                       const ModelParams& params) {
  if (layers.empty()) return {};
  const std::size_t n = layers.front().num_frames();
  const double sr = layers.front().sample_rate();
  AudioBuffer out(n, 2, sr);

  for (std::size_t i = 0; i < n; ++i) {
    float m = 0.f;
    for (std::size_t li = 0; li < layers.size(); ++li) {
      const float g = li < gains.size() ? gains[li] : 1.f;
      if (layers[li].num_frames() == n) m += layers[li].channel(0)[i] * g;
    }
    m *= params.output_gain;
    out.channel(0)[i] = m;
    out.channel(1)[i] = m;
  }
  return out;
}

}  // namespace nodruma::detail
