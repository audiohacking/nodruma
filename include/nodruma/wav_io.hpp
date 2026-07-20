#pragma once

#include "nodruma/audio_buffer.hpp"

#include <string>

namespace nodruma {

[[nodiscard]] bool load_wav(const std::string& path, AudioBuffer& out);
[[nodiscard]] bool save_wav(const std::string& path, const AudioBuffer& buf);

}  // namespace nodruma
