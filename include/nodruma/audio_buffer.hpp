#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

namespace nodruma {

/// Interleaved or planar stereo/mono buffer at a fixed sample rate.
class AudioBuffer {
public:
  AudioBuffer() = default;
  AudioBuffer(std::size_t num_frames, std::size_t num_channels, double sample_rate);

  [[nodiscard]] std::size_t num_frames() const noexcept { return num_frames_; }
  [[nodiscard]] std::size_t num_channels() const noexcept { return num_channels_; }
  [[nodiscard]] double sample_rate() const noexcept { return sample_rate_; }
  [[nodiscard]] bool empty() const noexcept { return num_frames_ == 0; }

  /// Planar channel access: channel i is contiguous.
  [[nodiscard]] float* channel(std::size_t ch);
  [[nodiscard]] const float* channel(std::size_t ch) const;
  [[nodiscard]] std::span<float> channel_span(std::size_t ch);
  [[nodiscard]] std::span<const float> channel_span(std::size_t ch) const;

  void clear();
  void resize(std::size_t num_frames, std::size_t num_channels, double sample_rate);

  /// Mix down to mono (average of channels) into dest (size num_frames).
  void to_mono(std::vector<float>& dest) const;

  /// Create mono buffer from planar mono samples.
  static AudioBuffer from_mono(std::span<const float> samples, double sample_rate);

  /// Duplicate mono into stereo.
  [[nodiscard]] AudioBuffer to_stereo() const;

private:
  std::size_t num_frames_ = 0;
  std::size_t num_channels_ = 0;
  double sample_rate_ = 44100.0;
  std::vector<float> data_;
};

}  // namespace nodruma
