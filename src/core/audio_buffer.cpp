#include "nodruma/audio_buffer.hpp"

#include <algorithm>
#include <stdexcept>

namespace nodruma {

AudioBuffer::AudioBuffer(std::size_t num_frames, std::size_t num_channels, double sample_rate) {
  resize(num_frames, num_channels, sample_rate);
}

float* AudioBuffer::channel(std::size_t ch) {
  if (ch >= num_channels_) throw std::out_of_range("channel");
  return data_.data() + ch * num_frames_;
}

const float* AudioBuffer::channel(std::size_t ch) const {
  if (ch >= num_channels_) throw std::out_of_range("channel");
  return data_.data() + ch * num_frames_;
}

std::span<float> AudioBuffer::channel_span(std::size_t ch) {
  return {channel(ch), num_frames_};
}

std::span<const float> AudioBuffer::channel_span(std::size_t ch) const {
  return {channel(ch), num_frames_};
}

void AudioBuffer::clear() {
  std::fill(data_.begin(), data_.end(), 0.f);
}

void AudioBuffer::resize(std::size_t num_frames, std::size_t num_channels, double sample_rate) {
  num_frames_ = num_frames;
  num_channels_ = num_channels;
  sample_rate_ = sample_rate;
  data_.assign(num_frames * num_channels, 0.f);
}

void AudioBuffer::to_mono(std::vector<float>& dest) const {
  dest.resize(num_frames_);
  if (num_channels_ == 0 || num_frames_ == 0) return;
  if (num_channels_ == 1) {
    std::copy(channel(0), channel(0) + num_frames_, dest.begin());
    return;
  }
  const float inv = 1.f / static_cast<float>(num_channels_);
  for (std::size_t i = 0; i < num_frames_; ++i) {
    float s = 0.f;
    for (std::size_t c = 0; c < num_channels_; ++c) s += channel(c)[i];
    dest[i] = s * inv;
  }
}

AudioBuffer AudioBuffer::from_mono(std::span<const float> samples, double sample_rate) {
  AudioBuffer buf(samples.size(), 1, sample_rate);
  std::copy(samples.begin(), samples.end(), buf.channel(0));
  return buf;
}

AudioBuffer AudioBuffer::to_stereo() const {
  if (num_channels_ == 2) return *this;
  AudioBuffer out(num_frames_, 2, sample_rate_);
  if (num_channels_ == 0) return out;
  const float* src = channel(0);
  std::copy(src, src + num_frames_, out.channel(0));
  std::copy(src, src + num_frames_, out.channel(1));
  return out;
}

}  // namespace nodruma
