#include "nodruma/session.hpp"
#include "nodruma/wav_io.hpp"

#include <cstdint>
#include <fstream>
#include <utility>

namespace nodruma {

AudioBuffer& LayerBuffers::get(LayerId id) {
  switch (id) {
    case LayerId::Transient: return transient;
    case LayerId::Foundation: return foundation;
    case LayerId::Tone: return tone;
    case LayerId::Noise: return noise;
    case LayerId::PercNoise: return perc_noise;
    case LayerId::Residue: return residue;
    default: return residue;
  }
}

const AudioBuffer& LayerBuffers::get(LayerId id) const {
  switch (id) {
    case LayerId::Transient: return transient;
    case LayerId::Foundation: return foundation;
    case LayerId::Tone: return tone;
    case LayerId::Noise: return noise;
    case LayerId::PercNoise: return perc_noise;
    case LayerId::Residue: return residue;
    default: return residue;
  }
}

struct Session::Impl {
  std::unique_ptr<IModel> model;
  ModelParams params;
  AudioBuffer input;
  AnalysisCache cache;

  Impl() { params.reset_defaults(); }
};

Session::Session() : impl_(std::make_unique<Impl>()) {}
Session::~Session() = default;
Session::Session(Session&&) noexcept = default;
Session& Session::operator=(Session&&) noexcept = default;

void Session::set_model(std::unique_ptr<IModel> model) {
  impl_->model = std::move(model);
  if (impl_->model) impl_->params = impl_->model->default_params();
}

const IModel* Session::model() const { return impl_->model.get(); }

void Session::set_params(const ModelParams& params) { impl_->params = params; }

ModelParams Session::params() const { return impl_->params; }

void Session::set_input(AudioBuffer input) {
  impl_->input = std::move(input);
  impl_->cache = AnalysisCache{};
  impl_->cache.sample_rate = impl_->input.sample_rate();
  impl_->cache.num_frames = impl_->input.num_frames();
}

const AudioBuffer& Session::input() const { return impl_->input; }

const AnalysisCache& Session::cache() const { return impl_->cache; }
AnalysisCache& Session::cache() { return impl_->cache; }

namespace {

constexpr char kMagic[8] = {'N', 'D', 'R', 'M', 'C', 'A', 'K', '1'};

bool write_vec(std::ofstream& f, const std::vector<float>& v) {
  const std::uint64_t n = v.size();
  f.write(reinterpret_cast<const char*>(&n), sizeof(n));
  if (!v.empty()) f.write(reinterpret_cast<const char*>(v.data()),
                          static_cast<std::streamsize>(v.size() * sizeof(float)));
  return static_cast<bool>(f);
}

bool read_vec(std::ifstream& f, std::vector<float>& v) {
  std::uint64_t n = 0;
  f.read(reinterpret_cast<char*>(&n), sizeof(n));
  if (!f) return false;
  v.resize(static_cast<std::size_t>(n));
  if (n) f.read(reinterpret_cast<char*>(v.data()),
                static_cast<std::streamsize>(n * sizeof(float)));
  return static_cast<bool>(f);
}

bool write_buf(std::ofstream& f, const AudioBuffer& b) {
  const std::uint64_t frames = b.num_frames();
  const std::uint64_t ch = b.num_channels();
  const double sr = b.sample_rate();
  f.write(reinterpret_cast<const char*>(&frames), sizeof(frames));
  f.write(reinterpret_cast<const char*>(&ch), sizeof(ch));
  f.write(reinterpret_cast<const char*>(&sr), sizeof(sr));
  for (std::size_t c = 0; c < b.num_channels(); ++c) {
    f.write(reinterpret_cast<const char*>(b.channel(c)),
            static_cast<std::streamsize>(b.num_frames() * sizeof(float)));
  }
  return static_cast<bool>(f);
}

bool read_buf(std::ifstream& f, AudioBuffer& b) {
  std::uint64_t frames = 0, ch = 0;
  double sr = 44100.0;
  f.read(reinterpret_cast<char*>(&frames), sizeof(frames));
  f.read(reinterpret_cast<char*>(&ch), sizeof(ch));
  f.read(reinterpret_cast<char*>(&sr), sizeof(sr));
  if (!f) return false;
  b.resize(static_cast<std::size_t>(frames), static_cast<std::size_t>(ch), sr);
  for (std::size_t c = 0; c < b.num_channels(); ++c) {
    f.read(reinterpret_cast<char*>(b.channel(c)),
           static_cast<std::streamsize>(b.num_frames() * sizeof(float)));
  }
  return static_cast<bool>(f);
}

}  // namespace

bool Session::save_cache(const std::string& path) const {
  if (!impl_->cache.valid) return false;
  std::ofstream f(path, std::ios::binary);
  if (!f) return false;
  f.write(kMagic, 8);
  const auto& c = impl_->cache;
  f.write(reinterpret_cast<const char*>(&c.sample_rate), sizeof(c.sample_rate));
  const std::uint64_t nf = c.num_frames;
  f.write(reinterpret_cast<const char*>(&nf), sizeof(nf));
  const std::int64_t onset = c.onset.primary_onset;
  f.write(reinterpret_cast<const char*>(&onset), sizeof(onset));
  f.write(reinterpret_cast<const char*>(&c.kick), sizeof(c.kick));
  write_vec(f, c.foundation_pitch_hz);
  write_vec(f, c.foundation_amp);
  write_vec(f, c.tone_amp);
  write_vec(f, c.noise_amp);
  write_vec(f, c.transient_amp);
  write_vec(f, c.perc_noise_amp);
  write_vec(f, c.body_wavetable);
  const std::uint64_t klen = c.kick_length_samples;
  f.write(reinterpret_cast<const char*>(&klen), sizeof(klen));
  write_buf(f, c.layers.residue);
  write_buf(f, c.layers.transient);
  write_buf(f, c.layers.foundation);
  write_buf(f, c.layers.tone);
  write_buf(f, c.layers.noise);
  write_buf(f, c.layers.perc_noise);
  return static_cast<bool>(f);
}

bool Session::load_cache(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  char magic[8];
  f.read(magic, 8);
  if (!f || std::string(magic, 8) != std::string(kMagic, 8)) return false;
  auto& c = impl_->cache;
  f.read(reinterpret_cast<char*>(&c.sample_rate), sizeof(c.sample_rate));
  std::uint64_t nf = 0;
  f.read(reinterpret_cast<char*>(&nf), sizeof(nf));
  c.num_frames = static_cast<std::size_t>(nf);
  std::int64_t onset = 0;
  f.read(reinterpret_cast<char*>(&onset), sizeof(onset));
  c.onset.primary_onset = onset;
  f.read(reinterpret_cast<char*>(&c.kick), sizeof(c.kick));
  if (!read_vec(f, c.foundation_pitch_hz)) return false;
  if (!read_vec(f, c.foundation_amp)) return false;
  if (!read_vec(f, c.tone_amp)) return false;
  if (!read_vec(f, c.noise_amp)) return false;
  if (!read_vec(f, c.transient_amp)) return false;
  if (!read_vec(f, c.perc_noise_amp)) return false;
  if (!read_vec(f, c.body_wavetable)) return false;
  std::uint64_t klen = 0;
  f.read(reinterpret_cast<char*>(&klen), sizeof(klen));
  c.kick_length_samples = static_cast<std::size_t>(klen);
  if (!read_buf(f, c.layers.residue)) return false;
  if (!read_buf(f, c.layers.transient)) return false;
  if (!read_buf(f, c.layers.foundation)) return false;
  if (!read_buf(f, c.layers.tone)) return false;
  if (!read_buf(f, c.layers.noise)) return false;
  if (!read_buf(f, c.layers.perc_noise)) return false;
  c.valid = true;
  return true;
}

}  // namespace nodruma
