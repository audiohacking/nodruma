#pragma once

#include "nodruma/audio_buffer.hpp"

#include <string>

namespace nodruma::detail {

[[nodiscard]] bool load_wav_file(const std::string& path, AudioBuffer& out);
[[nodiscard]] bool save_wav_file(const std::string& path, const AudioBuffer& buf);

}  // namespace nodruma::detail
