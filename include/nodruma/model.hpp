#pragma once

#include "nodruma/params.hpp"

#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace nodruma {

enum class LayerId {
  Transient = 0,
  Foundation,
  Tone,
  Noise,
  PercNoise,
  Residue,
  Count
};

[[nodiscard]] constexpr std::string_view layer_name(LayerId id) {
  switch (id) {
    case LayerId::Transient: return "transient";
    case LayerId::Foundation: return "foundation";
    case LayerId::Tone: return "tone";
    case LayerId::Noise: return "noise";
    case LayerId::PercNoise: return "perc_noise";
    case LayerId::Residue: return "residue";
    default: return "unknown";
  }
}

/// Frequency prior for soft mask generation (Hz).
struct BandPrior {
  float low_hz = 20.f;
  float high_hz = 20000.f;
  float center_hz = 100.f;
  float softness = 0.25f;  // relative transition width
};

struct OscillatorRecipe {
  enum class Kind { MonoSineDynamic, PolySineStatic, PolyNoiseStatic, PolyNoiseShort };
  Kind kind = Kind::MonoSineDynamic;
  int max_partials = 8;
  float noise_q = 2.f;
};

/// Model plugin: mask recipes, oscillator graph, defaults.
class IModel {
public:
  virtual ~IModel() = default;

  [[nodiscard]] virtual std::string_view id() const = 0;
  [[nodiscard]] virtual std::string_view name() const = 0;
  [[nodiscard]] virtual std::string_view description() const = 0;

  [[nodiscard]] virtual BandPrior band_prior(LayerId layer) const = 0;
  [[nodiscard]] virtual OscillatorRecipe oscillator(LayerId layer) const = 0;
  [[nodiscard]] virtual ModelParams default_params() const = 0;

  /// Suggested STFT size at 44.1 kHz (scaled by caller for other rates).
  [[nodiscard]] virtual int onset_fft_size_44100() const { return 128; }

  /// Foundation pitch search range.
  [[nodiscard]] virtual float pitch_min_hz() const { return 30.f; }
  [[nodiscard]] virtual float pitch_max_hz() const { return 200.f; }
};

[[nodiscard]] std::unique_ptr<IModel> create_model(std::string_view id);
[[nodiscard]] std::vector<std::string> list_models();

}  // namespace nodruma
