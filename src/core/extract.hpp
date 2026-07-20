#pragma once

#include "nodruma/model.hpp"
#include "nodruma/session.hpp"
#include "stft.hpp"

namespace nodruma::detail {

[[nodiscard]] LayerBuffers extract_layers(const float* mono, std::size_t n, double sample_rate,
                                          const OnsetResult& onset, const IModel& model,
                                          const ModelParams& params);

}  // namespace nodruma::detail
