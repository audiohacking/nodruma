#include "stft.hpp"

#include "fft.hpp"

#include <algorithm>
#include <cmath>
#include <complex>
#include <numbers>
#include <vector>

namespace nodruma::detail {

StftConfig make_onset_stft_config(double sample_rate, int size_at_44100) {
  StftConfig cfg;
  cfg.fft_size = stft_size_for_rate(sample_rate, size_at_44100);
  cfg.hop = std::max(1, cfg.fft_size / 2);
  return cfg;
}

StftConfig make_extract_stft_config(double sample_rate) {
  StftConfig cfg;
  cfg.fft_size = stft_size_for_rate(sample_rate, 1024);
  cfg.hop = std::max(1, cfg.fft_size / 4);
  return cfg;
}

namespace {

void hann_window(std::vector<float>& w) {
  const std::size_t n = w.size();
  const float two_pi = 2.f * std::numbers::pi_v<float>;
  for (std::size_t i = 0; i < n; ++i) {
    w[i] = 0.5f - 0.5f * std::cos(two_pi * static_cast<float>(i) / static_cast<float>(n));
  }
}

}  // namespace

StftData compute_stft(const float* mono, std::size_t n, double /*sample_rate*/,
                      const StftConfig& cfg) {
  StftData out;
  out.fft_size = cfg.fft_size;
  out.hop = cfg.hop;
  out.num_bins = cfg.fft_size / 2 + 1;
  if (n == 0) return out;

  const int fft_size = cfg.fft_size;
  const int hop = cfg.hop;
  out.num_frames = static_cast<int>((static_cast<int>(n) + hop - 1) / hop);
  out.mag.assign(static_cast<std::size_t>(out.num_frames * out.num_bins), 0.f);
  out.complex_ri.assign(static_cast<std::size_t>(out.num_frames * out.num_bins * 2), 0.f);

  Fft fft(static_cast<std::size_t>(fft_size));
  std::vector<float> window(static_cast<std::size_t>(fft_size));
  hann_window(window);
  std::vector<float> frame(static_cast<std::size_t>(fft_size), 0.f);
  std::vector<std::complex<float>> bins(static_cast<std::size_t>(out.num_bins));

  for (int f = 0; f < out.num_frames; ++f) {
    const int start = f * hop;
    std::fill(frame.begin(), frame.end(), 0.f);
    for (int i = 0; i < fft_size; ++i) {
      const int idx = start + i - fft_size / 2;
      if (idx >= 0 && idx < static_cast<int>(n)) {
        frame[static_cast<std::size_t>(i)] =
            mono[idx] * window[static_cast<std::size_t>(i)];
      }
    }
    fft.forward_real_complex(frame.data(), bins.data());
    for (int b = 0; b < out.num_bins; ++b) {
      const auto& c = bins[static_cast<std::size_t>(b)];
      const std::size_t mi = static_cast<std::size_t>(f * out.num_bins + b);
      out.mag[mi] = std::abs(c);
      const std::size_t ci = static_cast<std::size_t>((f * out.num_bins + b) * 2);
      out.complex_ri[ci] = c.real();
      out.complex_ri[ci + 1] = c.imag();
    }
  }
  return out;
}

std::vector<float> istft(const StftData& stft, std::size_t out_len, double /*sample_rate*/) {
  std::vector<float> out(out_len, 0.f);
  if (stft.num_frames == 0 || stft.fft_size == 0) return out;

  Fft fft(static_cast<std::size_t>(stft.fft_size));
  std::vector<float> window(static_cast<std::size_t>(stft.fft_size));
  hann_window(window);
  std::vector<float> norm(out_len, 0.f);
  std::vector<std::complex<float>> bins(static_cast<std::size_t>(stft.num_bins));
  std::vector<float> frame(static_cast<std::size_t>(stft.fft_size));

  for (int f = 0; f < stft.num_frames; ++f) {
    for (int b = 0; b < stft.num_bins; ++b) {
      const std::size_t ci = static_cast<std::size_t>((f * stft.num_bins + b) * 2);
      bins[static_cast<std::size_t>(b)] = {stft.complex_ri[ci], stft.complex_ri[ci + 1]};
    }
    fft.inverse_real_complex(bins.data(), frame.data());
    const int start = f * stft.hop;
    for (int i = 0; i < stft.fft_size; ++i) {
      const int idx = start + i - stft.fft_size / 2;
      if (idx >= 0 && idx < static_cast<int>(out_len)) {
        const float w = window[static_cast<std::size_t>(i)];
        out[static_cast<std::size_t>(idx)] += frame[static_cast<std::size_t>(i)] * w;
        norm[static_cast<std::size_t>(idx)] += w * w;
      }
    }
  }
  for (std::size_t i = 0; i < out_len; ++i) {
    if (norm[i] > 1e-8f) out[i] /= norm[i];
  }
  return out;
}

}  // namespace nodruma::detail
