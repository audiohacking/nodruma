#include "test_assert.hpp"

#include "core/body_cleanup.hpp"
#include "core/pitch_zc.hpp"

#include <cmath>
#include <numbers>
#include <vector>

void test_zc_pitch() {
  const double sr = 44100.0;
  const int n = 44100 / 4;  // 250 ms
  std::vector<float> x(static_cast<std::size_t>(n), 0.f);
  // Chirp-ish kick: 120 Hz → 50 Hz
  float phase = 0.f;
  for (int i = 0; i < n; ++i) {
    const float t = static_cast<float>(i) / static_cast<float>(sr);
    const float f = 120.f + (50.f - 120.f) * std::min(1.f, t / 0.08f);
    x[static_cast<std::size_t>(i)] =
        std::exp(-t * 6.f) * std::sin(phase);
    phase += 2.f * std::numbers::pi_v<float> * f / static_cast<float>(sr);
  }

  const int ref = static_cast<int>(sr / 30.0);
  auto widths = nodruma::detail::measure_halfcycle_widths(x.data(), 0, static_cast<std::size_t>(n), ref);
  CHECK(!widths.empty());
  auto freq = nodruma::detail::frequency_envelope_from_widths(widths, sr);
  CHECK(!freq.empty());
  // Early freq should be higher than late
  CHECK(freq.front() > freq.back());
  CHECK(freq.front() > 70.f);
  CHECK(freq.back() < 90.f);

  // Octave-high ZC contour should fold down to ~55 Hz anchor
  std::vector<float> hi(512, 110.f);
  nodruma::detail::anchor_pitch_envelope(hi, 55.f, 28.f, 130.f);
  CHECK(hi[0] > 40.f);
  CHECK(hi[0] < 75.f);

  float est = nodruma::detail::estimate_kick_fundamental_hz(x.data(), static_cast<std::size_t>(n), sr,
                                                           30.f, 120.f);
  CHECK(est > 40.f);
  CHECK(est < 100.f);
}

void test_body_cleanup() {
  const double sr = 44100.0;
  const int n = 2048;
  std::vector<float> x(static_cast<std::size_t>(n));
  std::vector<float> pitch(static_cast<std::size_t>(n), 60.f);
  for (int i = 0; i < n; ++i) {
    const float t = static_cast<float>(i) / static_cast<float>(sr);
    x[static_cast<std::size_t>(i)] =
        0.8f * std::sin(2.f * std::numbers::pi_v<float> * 60.f * t) +
        0.3f * std::sin(2.f * std::numbers::pi_v<float> * 2000.f * t);
  }
  nodruma::detail::cleanup_kick_body(x.data(), static_cast<std::size_t>(n), pitch.data(), sr);
  // HF should be attenuated — peak of residual HF reduced
  float hf = 0.f;
  for (int i = 100; i + 1 < n; ++i)
    hf = std::max(hf, std::fabs(x[static_cast<std::size_t>(i)] - x[static_cast<std::size_t>(i - 1)]));
  CHECK(hf < 0.5f);
  for (float v : x) CHECK(std::fabs(v) <= 1.0001f);
}
