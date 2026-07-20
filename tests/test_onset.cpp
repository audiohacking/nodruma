#include "test_assert.hpp"

#include "core/onset.hpp"
#include "nodruma/audio_buffer.hpp"

#include <cmath>
#include <numbers>
#include <vector>

void test_onset() {
  const double sr = 44100.0;
  const std::size_t n = 44100;  // 1 second
  const std::size_t click_at = 22050;
  std::vector<float> x(n, 0.f);
  // quiet tone then impulse burst
  for (std::size_t i = 0; i < 100; ++i) {
    const float t = static_cast<float>(i) / static_cast<float>(sr);
    x[click_at + i] = std::exp(-t * 200.f) *
                      std::sin(2.f * std::numbers::pi_v<float> * 80.f * t);
  }
  // add a small pre-noise so differentiation sees a jump
  x[click_at] = 1.f;

  auto result = nodruma::detail::detect_onsets(x.data(), x.size(), sr, 128, 1.0f);
  CHECK(!result.onsets.empty());
  const auto err = std::llabs(result.primary_onset - static_cast<std::int64_t>(click_at));
  CHECK(err < 2048);  // within ~46 ms
}
