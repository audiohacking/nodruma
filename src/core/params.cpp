#include "nodruma/params.hpp"

#include <algorithm>
#include <cstdio>
#include <sstream>

namespace nodruma {

float SegmentEnvelope::evaluate(float t_seconds) const {
  if (points.empty()) return 0.f;
  if (points.size() == 1) return points.front().value;
  if (t_seconds <= points.front().time) return points.front().value;
  if (t_seconds >= points.back().time) return points.back().value;
  for (std::size_t i = 0; i + 1 < points.size(); ++i) {
    if (t_seconds >= points[i].time && t_seconds <= points[i + 1].time) {
      const float t0 = points[i].time;
      const float t1 = points[i + 1].time;
      const float u = (t1 > t0) ? (t_seconds - t0) / (t1 - t0) : 0.f;
      return points[i].value + u * (points[i + 1].value - points[i].value);
    }
  }
  return points.back().value;
}

void SegmentEnvelope::set_constant(float value) {
  points = {{0.f, value}, {10.f, value}};
}

void SegmentEnvelope::set_adsr(float attack, float decay, float sustain, float release,
                               float peak) {
  points.clear();
  points.push_back({0.f, 0.f});
  points.push_back({attack, peak});
  points.push_back({attack + decay, sustain});
  points.push_back({attack + decay + release, 0.f});
}

void ModelParams::reset_defaults() {
  *this = ModelParams{};
  transient_env.set_constant(1.f);
  foundation_env.set_constant(1.f);
  tone_env.set_constant(1.f);
  noise_env.set_constant(1.f);
  perc_noise_env.set_constant(1.f);
}

namespace {

void append_env(std::ostringstream& os, const char* name, const SegmentEnvelope& e) {
  os << "\"" << name << "\":[";
  for (std::size_t i = 0; i < e.points.size(); ++i) {
    if (i) os << ',';
    os << "{\"t\":" << e.points[i].time << ",\"v\":" << e.points[i].value << '}';
  }
  os << ']';
}

float find_number(const std::string& json, const char* key, float fallback) {
  const std::string pat = std::string("\"") + key + "\"";
  auto pos = json.find(pat);
  if (pos == std::string::npos) return fallback;
  pos = json.find(':', pos);
  if (pos == std::string::npos) return fallback;
  float v = fallback;
  if (std::sscanf(json.c_str() + pos + 1, "%f", &v) == 1) return v;
  return fallback;
}

}  // namespace

bool params_to_json(const ModelParams& p, std::string& out) {
  std::ostringstream os;
  os << '{';
  os << "\"transient_gain\":" << p.transient_gain << ',';
  os << "\"foundation_gain\":" << p.foundation_gain << ',';
  os << "\"tone_gain\":" << p.tone_gain << ',';
  os << "\"noise_gain\":" << p.noise_gain << ',';
  os << "\"perc_noise_gain\":" << p.perc_noise_gain << ',';
  os << "\"residue_gain\":" << p.residue_gain << ',';
  os << "\"foundation_pitch_scale\":" << p.foundation_pitch_scale << ',';
  os << "\"tone_brightness\":" << p.tone_brightness << ',';
  os << "\"noise_brightness\":" << p.noise_brightness << ',';
  os << "\"attack_tighten\":" << p.attack_tighten << ',';
  os << "\"body_decay\":" << p.body_decay << ',';
  os << "\"stereo_width\":" << p.stereo_width << ',';
  os << "\"output_gain\":" << p.output_gain << ',';
  append_env(os, "foundation_env", p.foundation_env);
  os << '}';
  out = os.str();
  return true;
}

bool params_from_json(const std::string& json, ModelParams& out) {
  out.reset_defaults();
  out.transient_gain = find_number(json, "transient_gain", out.transient_gain);
  out.foundation_gain = find_number(json, "foundation_gain", out.foundation_gain);
  out.tone_gain = find_number(json, "tone_gain", out.tone_gain);
  out.noise_gain = find_number(json, "noise_gain", out.noise_gain);
  out.perc_noise_gain = find_number(json, "perc_noise_gain", out.perc_noise_gain);
  out.residue_gain = find_number(json, "residue_gain", out.residue_gain);
  out.foundation_pitch_scale =
      find_number(json, "foundation_pitch_scale", out.foundation_pitch_scale);
  out.tone_brightness = find_number(json, "tone_brightness", out.tone_brightness);
  out.noise_brightness = find_number(json, "noise_brightness", out.noise_brightness);
  out.attack_tighten = find_number(json, "attack_tighten", out.attack_tighten);
  out.body_decay = find_number(json, "body_decay", out.body_decay);
  out.stereo_width = find_number(json, "stereo_width", out.stereo_width);
  out.output_gain = find_number(json, "output_gain", out.output_gain);
  return true;
}

}  // namespace nodruma
