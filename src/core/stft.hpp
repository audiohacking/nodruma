#pragma once

#include "nodruma/session.hpp"

#include <vector>

namespace nodruma::detail {

struct StftConfig {
  int fft_size = 128;
  int hop = 64;
};

struct StftData {
  int fft_size = 0;
  int hop = 0;
  int num_bins = 0;
  int num_frames = 0;
  /// Magnitude spectrogram [frame * num_bins + bin]
  std::vector<float> mag;
  /// Complex spectrogram interleaved re,im per bin [frame * num_bins * 2 + ...]
  std::vector<float> complex_ri;
};

[[nodiscard]] StftConfig make_onset_stft_config(double sample_rate, int size_at_44100 = 128);
[[nodiscard]] StftConfig make_extract_stft_config(double sample_rate);

[[nodiscard]] StftData compute_stft(const float* mono, std::size_t n, double sample_rate,
                                    const StftConfig& cfg);

[[nodiscard]] std::vector<float> istft(const StftData& stft, std::size_t out_len,
                                       double sample_rate);

}  // namespace nodruma::detail
