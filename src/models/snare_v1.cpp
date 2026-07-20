#include "nodruma/model.hpp"

namespace nodruma {

namespace {

class SnareV1 final : public IModel {
public:
  std::string_view id() const override { return "snare"; }
  std::string_view name() const override { return "snare/v1"; }
  std::string_view description() const override {
    return "Snare model: mid body tone + strong noise / snare-wire layer";
  }

  BandPrior band_prior(LayerId layer) const override {
    switch (layer) {
      case LayerId::Transient:
        return {2000.f, 16000.f, 7000.f, 0.35f};
      case LayerId::Foundation:
        return {80.f, 250.f, 160.f, 0.3f};
      case LayerId::Tone:
        return {150.f, 1200.f, 400.f, 0.35f};
      case LayerId::Noise:
        return {800.f, 10000.f, 3500.f, 0.45f};
      case LayerId::PercNoise:
        return {3000.f, 16000.f, 8000.f, 0.4f};
      default:
        return {20.f, 20000.f, 2000.f, 0.5f};
    }
  }

  OscillatorRecipe oscillator(LayerId layer) const override {
    OscillatorRecipe r;
    switch (layer) {
      case LayerId::Foundation:
        r.kind = OscillatorRecipe::Kind::MonoSineDynamic;
        break;
      case LayerId::Tone:
        r.kind = OscillatorRecipe::Kind::PolySineStatic;
        r.max_partials = 8;
        break;
      case LayerId::Noise:
        r.kind = OscillatorRecipe::Kind::PolyNoiseStatic;
        r.noise_q = 1.5f;
        break;
      default:
        r.kind = OscillatorRecipe::Kind::PolyNoiseShort;
        r.noise_q = 1.0f;
        break;
    }
    return r;
  }

  ModelParams default_params() const override {
    ModelParams p;
    p.reset_defaults();
    p.foundation_gain = 0.55f;
    p.tone_gain = 0.6f;
    p.noise_gain = 1.0f;
    p.transient_gain = 0.9f;
    p.perc_noise_gain = 0.7f;
    p.noise_brightness = 1.15f;
    p.body_decay = 0.85f;
    return p;
  }

  float pitch_min_hz() const override { return 100.f; }
  float pitch_max_hz() const override { return 400.f; }
  int onset_fft_size_44100() const override { return 128; }
};

}  // namespace

std::unique_ptr<IModel> make_snare_v1() { return std::make_unique<SnareV1>(); }

}  // namespace nodruma
