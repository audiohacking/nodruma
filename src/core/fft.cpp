#include "fft.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <numbers>
#include <stdexcept>

namespace nodruma::detail {

std::size_t next_pow2(std::size_t n) {
  std::size_t p = 1;
  while (p < n) p <<= 1;
  return p;
}

int stft_size_for_rate(double sample_rate, int size_at_44100) {
  // Clamp to practical audio rates so pathological inputs can't explode FFT size.
  const double sr = std::clamp(sample_rate, 8000.0, 192000.0);
  const int base = std::max(32, size_at_44100);
  const double scale = sr / 44100.0;
  const int sz = std::max(1, static_cast<int>(std::lround(static_cast<double>(base) * scale)));
  // Nearest power of two (min 64). Ceiling-only snap jumps 48 kHz 1024→2048 and
  // changes onset/classify behavior vs 44.1 kHz.
  int lo = 32;
  while (lo * 2 < sz) lo <<= 1;
  const int hi = lo << 1;
  const int nearest = (sz - lo <= hi - sz) ? lo : hi;
  return std::max(64, nearest);
}

Fft::Fft(std::size_t size) : size_(size) {
  if (size_ == 0 || (size_ & (size_ - 1)) != 0) {
    throw std::invalid_argument("FFT size must be power of two");
  }
  twiddles_.resize(size_ / 2);
  const float two_pi = 2.f * std::numbers::pi_v<float>;
  for (std::size_t i = 0; i < size_ / 2; ++i) {
    const float angle = -two_pi * static_cast<float>(i) / static_cast<float>(size_);
    twiddles_[i] = {std::cos(angle), std::sin(angle)};
  }
  work_.resize(size_);
}

void Fft::fft_radix2(std::complex<float>* data, bool inverse) const {
  const std::size_t n = size_;
  // bit reverse
  for (std::size_t i = 1, j = 0; i < n; ++i) {
    std::size_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) std::swap(data[i], data[j]);
  }

  for (std::size_t len = 2; len <= n; len <<= 1) {
    const std::size_t half = len >> 1;
    const std::size_t step = n / len;
    for (std::size_t i = 0; i < n; i += len) {
      for (std::size_t j = 0; j < half; ++j) {
        std::complex<float> w = twiddles_[j * step];
        if (inverse) w = std::conj(w);
        const auto u = data[i + j];
        const auto v = data[i + j + half] * w;
        data[i + j] = u + v;
        data[i + j + half] = u - v;
      }
    }
  }

  if (inverse) {
    const float inv = 1.f / static_cast<float>(n);
    for (std::size_t i = 0; i < n; ++i) data[i] *= inv;
  }
}

void Fft::forward_real_complex(const float* time, std::complex<float>* bins) const {
  for (std::size_t i = 0; i < size_; ++i) work_[i] = {time[i], 0.f};
  fft_radix2(work_.data(), false);
  // bins 0..n/2
  const std::size_t half = size_ / 2;
  for (std::size_t i = 0; i <= half; ++i) bins[i] = work_[i];
}

void Fft::inverse_real_complex(const std::complex<float>* bins, float* time) const {
  const std::size_t half = size_ / 2;
  work_[0] = bins[0];
  work_[half] = bins[half];
  for (std::size_t i = 1; i < half; ++i) {
    work_[i] = bins[i];
    work_[size_ - i] = std::conj(bins[i]);
  }
  fft_radix2(work_.data(), true);
  for (std::size_t i = 0; i < size_; ++i) time[i] = work_[i].real();
}

void Fft::forward_real(const float* time, float* freq_packed) const {
  std::vector<std::complex<float>> bins(size_ / 2 + 1);
  forward_real_complex(time, bins.data());
  const std::size_t half = size_ / 2;
  freq_packed[0] = bins[0].real();
  freq_packed[1] = bins[half].real();
  for (std::size_t i = 1; i < half; ++i) {
    freq_packed[2 * i] = bins[i].real();
    freq_packed[2 * i + 1] = bins[i].imag();
  }
}

void Fft::inverse_real(const float* freq_packed, float* time) const {
  std::vector<std::complex<float>> bins(size_ / 2 + 1);
  const std::size_t half = size_ / 2;
  bins[0] = {freq_packed[0], 0.f};
  bins[half] = {freq_packed[1], 0.f};
  for (std::size_t i = 1; i < half; ++i) {
    bins[i] = {freq_packed[2 * i], freq_packed[2 * i + 1]};
  }
  inverse_real_complex(bins.data(), time);
}

}  // namespace nodruma::detail
