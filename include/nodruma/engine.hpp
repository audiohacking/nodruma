#pragma once

#include "nodruma/audio_buffer.hpp"
#include "nodruma/session.hpp"

#include <string>

namespace nodruma {

struct ProcessOptions {
  bool dump_layers = false;
  std::string layer_dump_dir;
  /// If true, only run resynthesis from existing cache.
  bool morph_only = false;
};

class Engine {
public:
  Engine() = default;

  /// Full pipeline: analyze → extract → match → resynth → mix.
  [[nodiscard]] AudioBuffer process(Session& session, const ProcessOptions& opts = {});

  /// Analysis + onset only (fills session.cache().onset).
  void detect(Session& session);

  /// Analyze + extract layers into cache (no resynth).
  void analyze_and_extract(Session& session);

  /// Resynth + mix from cache + current params (fast morph path).
  [[nodiscard]] AudioBuffer resynthesize(Session& session);
};

}  // namespace nodruma
