#pragma once

#include "nodruma/audio_buffer.hpp"
#include "nodruma/params.hpp"

#include <vector>

namespace nodruma::detail {

[[nodiscard]] AudioBuffer mix_layers(const std::vector<AudioBuffer>& layers,
                                     const std::vector<float>& gains,
                                     const ModelParams& params);

}  // namespace nodruma::detail
