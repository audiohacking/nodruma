#pragma once

#include "nodruma/session.hpp"

namespace nodruma::detail {

[[nodiscard]] OnsetResult detect_onsets(const float* mono, std::size_t n, double sample_rate,
                                        int fft_size_44100 = 128,
                                        float threshold_scale = 1.0f);

}  // namespace nodruma::detail
