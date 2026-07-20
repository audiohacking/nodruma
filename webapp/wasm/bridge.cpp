#include <emscripten.h>

#include "nodruma/audio_buffer.hpp"
#include "nodruma/engine.hpp"
#include "nodruma/model.hpp"
#include "nodruma/session.hpp"
#include "nodruma/split.hpp"

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <span>
#include <sstream>
#include <string>
#include <vector>

namespace {

struct CachedHit {
  std::string kind;
  float confidence = 0.f;
  std::int64_t onset = 0;
  float lf = 0.f;
  float hf = 0.f;
  float centroid = 0.f;
  std::vector<float> pcm;
  double sample_rate = 44100.0;
};

std::vector<CachedHit> g_hits;

char* dup_cstr(const std::string& s) {
  char* p = static_cast<char*>(std::malloc(s.size() + 1));
  if (!p) return nullptr;
  std::memcpy(p, s.c_str(), s.size() + 1);
  return p;
}

std::vector<float> buffer_to_mono(const nodruma::AudioBuffer& buf) {
  std::vector<float> mono;
  buf.to_mono(mono);
  return mono;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
void* nd_malloc(std::size_t n) { return std::malloc(n); }

EMSCRIPTEN_KEEPALIVE
void nd_free(void* p) { std::free(p); }

EMSCRIPTEN_KEEPALIVE
const char* nd_version(void) { return "0.1.0"; }

EMSCRIPTEN_KEEPALIVE
void nd_clear_hits(void) { g_hits.clear(); }

/// Split mono loop into hits. Returns malloc'd JSON metadata (caller nd_free).
/// PCM is cached; fetch with nd_hit_pcm / nd_hit_count.
EMSCRIPTEN_KEEPALIVE
char* nd_split(float* mono, int n, double sample_rate, float threshold, float min_gap) {
  g_hits.clear();
  if (!mono || n <= 0 || sample_rate <= 0.0) {
    return dup_cstr("{\"sample_rate\":0,\"num_hits\":0,\"hits\":[]}");
  }

  nodruma::SplitOptions opts;
  opts.threshold_scale = threshold > 0.f ? threshold : 1.f;
  opts.min_gap_sec = min_gap > 0.f ? min_gap : 0.048f;

  const auto split =
      nodruma::split_groove(mono, static_cast<std::size_t>(n), sample_rate, opts);

  nodruma::AudioBuffer source =
      nodruma::AudioBuffer::from_mono(
          std::span<const float>(mono, static_cast<std::size_t>(n)), sample_rate)
          .to_stereo();

  std::ostringstream json;
  json << "{\"sample_rate\":" << sample_rate << ",\"num_hits\":" << split.hits.size()
       << ",\"hits\":[";

  for (std::size_t i = 0; i < split.hits.size(); ++i) {
    const auto& h = split.hits[i];
    nodruma::AudioBuffer one = nodruma::extract_hit(source, h);
    CachedHit ch;
    ch.kind = nodruma::hit_kind_name(h.kind);
    ch.confidence = h.confidence;
    ch.onset = h.onset_sample;
    ch.lf = h.lf_ratio;
    ch.hf = h.hf_ratio;
    ch.centroid = h.centroid_hz;
    ch.sample_rate = sample_rate;
    ch.pcm = buffer_to_mono(one);
    g_hits.push_back(std::move(ch));

    if (i) json << ',';
    json << "{\"index\":" << i << ",\"kind\":\"" << g_hits.back().kind
         << "\",\"confidence\":" << h.confidence << ",\"onset_sample\":" << h.onset_sample
         << ",\"lf_ratio\":" << h.lf_ratio << ",\"hf_ratio\":" << h.hf_ratio
         << ",\"centroid_hz\":" << h.centroid_hz << ",\"frames\":" << g_hits.back().pcm.size()
         << "}";
  }
  json << "]}";
  return dup_cstr(json.str());
}

EMSCRIPTEN_KEEPALIVE
int nd_hit_count(void) { return static_cast<int>(g_hits.size()); }

/// Pointer to mono PCM for hit index (valid until nd_clear_hits / next nd_split).
EMSCRIPTEN_KEEPALIVE
float* nd_hit_pcm(int index, int* out_frames, double* out_sr) {
  if (index < 0 || index >= static_cast<int>(g_hits.size())) {
    if (out_frames) *out_frames = 0;
    return nullptr;
  }
  auto& h = g_hits[static_cast<std::size_t>(index)];
  if (out_frames) *out_frames = static_cast<int>(h.pcm.size());
  if (out_sr) *out_sr = h.sample_rate;
  return h.pcm.empty() ? nullptr : h.pcm.data();
}

/// Recreate one hit. Returns malloc'd mono PCM; *out_frames set. Caller nd_free.
EMSCRIPTEN_KEEPALIVE
float* nd_recreate(float* mono, int n, double sample_rate, const char* model_id,
                   int* out_frames) {
  if (out_frames) *out_frames = 0;
  if (!mono || n <= 0 || sample_rate <= 0.0 || !model_id) return nullptr;

  const char* mid = model_id;
  if (std::strcmp(mid, "kick") != 0 && std::strcmp(mid, "snare") != 0 &&
      std::strcmp(mid, "hat") != 0) {
    return nullptr;
  }

  nodruma::Session session;
  session.set_model(nodruma::create_model(mid));
  auto input = nodruma::AudioBuffer::from_mono(
                   std::span<const float>(mono, static_cast<std::size_t>(n)), sample_rate)
                   .to_stereo();
  session.set_input(std::move(input));

  nodruma::Engine eng;
  auto out = eng.process(session);
  if (out.empty()) return nullptr;

  auto mono_out = buffer_to_mono(out);
  float* buf = static_cast<float*>(std::malloc(mono_out.size() * sizeof(float)));
  if (!buf) return nullptr;
  std::memcpy(buf, mono_out.data(), mono_out.size() * sizeof(float));
  if (out_frames) *out_frames = static_cast<int>(mono_out.size());
  return buf;
}

}  // extern "C"
