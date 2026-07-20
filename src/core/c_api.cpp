#include "nodruma/nodruma.h"

#include "nodruma/engine.hpp"
#include "nodruma/model.hpp"
#include "nodruma/session.hpp"
#include "nodruma/wav_io.hpp"

#include <algorithm>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

struct NodrumaEngine {
  nodruma::Engine eng;
};

struct NodrumaSession {
  nodruma::Session sess;
};

const char* nodruma_version(void) {
#ifdef NODRUMA_VERSION
  return NODRUMA_VERSION;
#else
  return "0.0.0";
#endif
}

NodrumaEngine* nodruma_engine_create(void) { return new NodrumaEngine(); }
void nodruma_engine_destroy(NodrumaEngine* eng) { delete eng; }

NodrumaSession* nodruma_session_create(void) { return new NodrumaSession(); }
void nodruma_session_destroy(NodrumaSession* sess) { delete sess; }

int nodruma_session_set_model(NodrumaSession* sess, const char* model_id) {
  if (!sess || !model_id) return 0;
  auto m = nodruma::create_model(model_id);
  if (!m) return 0;
  sess->sess.set_model(std::move(m));
  return 1;
}

int nodruma_session_load_wav(NodrumaSession* sess, const char* path) {
  if (!sess || !path) return 0;
  nodruma::AudioBuffer buf;
  if (!nodruma::load_wav(path, buf)) return 0;
  sess->sess.set_input(std::move(buf));
  return 1;
}

int nodruma_session_save_wav(const float* interleaved, size_t frames, size_t channels,
                             double sample_rate, const char* path) {
  if (!interleaved || !path || frames == 0 || channels == 0) return 0;
  nodruma::AudioBuffer buf(frames, channels, sample_rate);
  for (size_t c = 0; c < channels; ++c) {
    float* dest = buf.channel(c);
    for (size_t i = 0; i < frames; ++i) dest[i] = interleaved[i * channels + c];
  }
  return nodruma::save_wav(path, buf) ? 1 : 0;
}

int nodruma_process(NodrumaEngine* eng, NodrumaSession* sess, float* out_interleaved,
                    size_t max_frames, size_t* out_channels) {
  if (!eng || !sess || !out_interleaved) return -1;
  auto out = eng->eng.process(sess->sess);
  if (out.empty()) return -1;
  if (out_channels) *out_channels = out.num_channels();
  const size_t frames = std::min(max_frames, out.num_frames());
  for (size_t i = 0; i < frames; ++i) {
    for (size_t c = 0; c < out.num_channels(); ++c) {
      out_interleaved[i * out.num_channels() + c] = out.channel(c)[i];
    }
  }
  return static_cast<int>(frames);
}
