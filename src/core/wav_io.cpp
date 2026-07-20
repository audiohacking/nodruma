#define DR_WAV_IMPLEMENTATION
#include "dr_wav.h"

#include "nodruma/audio_buffer.hpp"
#include "wav_io_impl.hpp"

#include <vector>

namespace nodruma::detail {

bool load_wav_file(const std::string& path, AudioBuffer& out) {
  drwav wav;
  if (!drwav_init_file(&wav, path.c_str(), nullptr)) return false;

  const std::size_t frames = static_cast<std::size_t>(wav.totalPCMFrameCount);
  const std::size_t ch = wav.channels;
  std::vector<float> interleaved(frames * ch);
  const drwav_uint64 read =
      drwav_read_pcm_frames_f32(&wav, wav.totalPCMFrameCount, interleaved.data());
  const double sr = wav.sampleRate;
  drwav_uninit(&wav);
  if (read == 0) return false;

  out.resize(static_cast<std::size_t>(read), ch, sr);
  for (std::size_t c = 0; c < ch; ++c) {
    float* dest = out.channel(c);
    for (std::size_t i = 0; i < static_cast<std::size_t>(read); ++i) {
      dest[i] = interleaved[i * ch + c];
    }
  }
  return true;
}

bool save_wav_file(const std::string& path, const AudioBuffer& buf) {
  if (buf.empty()) return false;
  std::vector<float> interleaved(buf.num_frames() * buf.num_channels());
  for (std::size_t i = 0; i < buf.num_frames(); ++i) {
    for (std::size_t c = 0; c < buf.num_channels(); ++c) {
      interleaved[i * buf.num_channels() + c] = buf.channel(c)[i];
    }
  }

  drwav_data_format format{};
  format.container = drwav_container_riff;
  format.format = DR_WAVE_FORMAT_IEEE_FLOAT;
  format.channels = static_cast<drwav_uint32>(buf.num_channels());
  format.sampleRate = static_cast<drwav_uint32>(buf.sample_rate());
  format.bitsPerSample = 32;

  drwav wav;
  if (!drwav_init_file_write(&wav, path.c_str(), &format, nullptr)) return false;
  drwav_write_pcm_frames(&wav, buf.num_frames(), interleaved.data());
  drwav_uninit(&wav);
  return true;
}

}  // namespace nodruma::detail

namespace nodruma {

bool load_wav(const std::string& path, AudioBuffer& out) {
  return detail::load_wav_file(path, out);
}

bool save_wav(const std::string& path, const AudioBuffer& buf) {
  return detail::save_wav_file(path, buf);
}

}  // namespace nodruma
