#include "nodruma/engine.hpp"
#include "nodruma/wav_io.hpp"

#include "extract.hpp"
#include "onset.hpp"
#include "synth.hpp"

#include <filesystem>
#include <vector>

namespace nodruma {

void Engine::detect(Session& session) {
  if (!session.model() || session.input().empty()) return;
  std::vector<float> mono;
  session.input().to_mono(mono);
  session.cache().onset =
      detail::detect_onsets(mono.data(), mono.size(), session.input().sample_rate(),
                             session.model()->onset_fft_size_44100());
  session.cache().sample_rate = session.input().sample_rate();
  session.cache().num_frames = mono.size();
}

void Engine::analyze_and_extract(Session& session) {
  detect(session);
  if (!session.model() || session.input().empty()) return;
  std::vector<float> mono;
  session.input().to_mono(mono);
  session.cache().layers =
      detail::extract_layers(mono.data(), mono.size(), session.input().sample_rate(),
                             session.cache().onset, *session.model(), session.params());
  session.cache().num_frames = mono.size();
  session.cache().sample_rate = session.input().sample_rate();
  detail::match_envelopes(session.cache(), *session.model(), mono.data(), mono.size());
}

AudioBuffer Engine::resynthesize(Session& session) {
  if (!session.model() || !session.cache().valid) {
    return AudioBuffer{};
  }
  return detail::resynthesize(session.cache(), *session.model(), session.params());
}

AudioBuffer Engine::process(Session& session, const ProcessOptions& opts) {
  if (opts.morph_only) {
    return resynthesize(session);
  }
  analyze_and_extract(session);

  if (opts.dump_layers && !opts.layer_dump_dir.empty()) {
    namespace fs = std::filesystem;
    fs::create_directories(opts.layer_dump_dir);
    auto& L = session.cache().layers;
    (void)save_wav((fs::path(opts.layer_dump_dir) / "transient.wav").string(), L.transient);
    (void)save_wav((fs::path(opts.layer_dump_dir) / "foundation.wav").string(), L.foundation);
    (void)save_wav((fs::path(opts.layer_dump_dir) / "tone.wav").string(), L.tone);
    (void)save_wav((fs::path(opts.layer_dump_dir) / "noise.wav").string(), L.noise);
    (void)save_wav((fs::path(opts.layer_dump_dir) / "perc_noise.wav").string(), L.perc_noise);
    (void)save_wav((fs::path(opts.layer_dump_dir) / "residue.wav").string(), L.residue);
  }

  return resynthesize(session);
}

}  // namespace nodruma
