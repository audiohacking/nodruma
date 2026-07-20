#include "test_assert.hpp"

#include "core/fft.hpp"

#include <cmath>
#include <complex>
#include <numbers>
#include <vector>

void test_fft() {
  using nodruma::detail::Fft;
  constexpr int N = 256;
  Fft fft(N);
  std::vector<float> time(N);
  for (int i = 0; i < N; ++i) {
    time[static_cast<std::size_t>(i)] =
        std::sin(2.f * std::numbers::pi_v<float> * 4.f * static_cast<float>(i) /
                 static_cast<float>(N));
  }
  std::vector<std::complex<float>> bins(N / 2 + 1);
  fft.forward_real_complex(time.data(), bins.data());
  // Peak should be near bin 4
  int peak = 0;
  float best = 0.f;
  for (int i = 0; i <= N / 2; ++i) {
    const float m = std::abs(bins[static_cast<std::size_t>(i)]);
    if (m > best) {
      best = m;
      peak = i;
    }
  }
  CHECK(peak == 4);

  std::vector<float> back(N);
  fft.inverse_real_complex(bins.data(), back.data());
  float err = 0.f;
  for (int i = 0; i < N; ++i)
    err += std::fabs(back[static_cast<std::size_t>(i)] - time[static_cast<std::size_t>(i)]);
  err /= static_cast<float>(N);
  CHECK(err < 1e-4f);
}
