#pragma once

#include <complex>
#include <cstddef>
#include <vector>

namespace nodruma::detail {

/// Real forward / inverse FFT (power-of-two sizes). Forward: real → packed complex.
class Fft {
public:
  explicit Fft(std::size_t size);

  [[nodiscard]] std::size_t size() const noexcept { return size_; }

  /// In-place real FFT: time[0..n) → spectrum as interleaved re/im for bins 0..n/2
  /// stored in out (size n: out[0]=DC.re, out[1]=Nyquist.re, then pairs).
  void forward_real(const float* time, float* freq_packed) const;

  /// Inverse of forward_real (normalized 1/n).
  void inverse_real(const float* freq_packed, float* time) const;

  /// Complex spectrum helper: returns complex bins 0..n/2 inclusive.
  void forward_real_complex(const float* time, std::complex<float>* bins) const;
  void inverse_real_complex(const std::complex<float>* bins, float* time) const;

private:
  std::size_t size_ = 0;
  std::vector<std::complex<float>> twiddles_;
  mutable std::vector<std::complex<float>> work_;

  void fft_radix2(std::complex<float>* data, bool inverse) const;
};

[[nodiscard]] std::size_t next_pow2(std::size_t n);
[[nodiscard]] int stft_size_for_rate(double sample_rate, int size_at_44100 = 128);

}  // namespace nodruma::detail
