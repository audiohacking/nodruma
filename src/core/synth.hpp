#pragma once

#include "nodruma/model.hpp"
#include "nodruma/session.hpp"

namespace nodruma::detail {

/// Match amp/pitch envelopes from mono input.
/// Kick: Stage-3 body isolation. Snare/hat: refine STFT extract layers.
void match_envelopes(AnalysisCache& cache, const IModel& model, const float* mono,
                     std::size_t n);

[[nodiscard]] AudioBuffer resynthesize(const AnalysisCache& cache, const IModel& model,
                                       const ModelParams& params);

}  // namespace nodruma::detail
