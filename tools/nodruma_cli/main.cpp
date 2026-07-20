#include "nodruma/engine.hpp"
#include "nodruma/model.hpp"
#include "nodruma/params.hpp"
#include "nodruma/session.hpp"
#include "nodruma/split.hpp"
#include "nodruma/wav_io.hpp"
#include "nodruma/nodruma.h"

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

void usage_overview() {
  std::cout
      << "nodruma — portable drum extraction / resynthesis (early tester build)\n"
      << "\n"
      << "Commands:\n"
      << "  process   Rebuild a one-shot (kick / snare / hat) from a WAV\n"
      << "  split     Chop a groove into hits; optionally recreate each\n"
      << "  detect    Print kick-oriented onset info for a file\n"
      << "  morph     Re-render from a saved session cache (kick morph)\n"
      << "  info      List models\n"
      << "  version   Print version\n"
      << "  help      This text, or `nodruma help <command>`\n"
      << "\n"
      << "Quick examples:\n"
      << "  nodruma process --model kick --in kick.wav --out out.wav\n"
      << "  nodruma split --in groove.wav --out-dir out/split --extract\n"
      << "\n"
      << "See docs/USAGE.md for workflows and known limits.\n";
}

void usage_process() {
  std::cout
      << "nodruma process — analyze + resynthesize one drum hit\n"
      << "\n"
      << "  nodruma process --model kick|snare|hat --in in.wav --out out.wav\n"
      << "                 [--params p.json] [--dump-layers dir] [--write-session cache.bin]\n"
      << "\n"
      << "  --model     kick (default): Stage-3 body path\n"
      << "              snare / hat: gated STFT layer mix\n"
      << "  --dump-layers   write transient/foundation/tone/noise WAVs\n"
      << "  --write-session save analysis cache for `morph`\n";
}

void usage_split() {
  std::cout
      << "nodruma split — chop a groove into one-shots (transient flux)\n"
      << "\n"
      << "  nodruma split --in groove.wav --out-dir dir\n"
      << "               [--extract] [--threshold 1.0] [--min-gap 0.048]\n"
      << "               [--max-hit 0.42] [--no-classify] [--prefix name]\n"
      << "\n"
      << "Writes numbered WAVs + hits.json under --out-dir.\n"
      << "With --extract, classified kicks/snares/hats are also run through\n"
      << "`process` into out-dir/extracted/ (unknown hits are skipped).\n"
      << "\n"
      << "Tuning:\n"
      << "  --threshold   lower → more hits (default 1.0)\n"
      << "  --min-gap     minimum seconds between onsets\n"
      << "  --max-hit     max one-shot length in seconds\n";
}

void usage_detect() {
  std::cout
      << "nodruma detect — kick-oriented onset detection\n"
      << "\n"
      << "  nodruma detect --in in.wav [--model kick] [--write-onset onset.csv]\n";
}

void usage_morph() {
  std::cout
      << "nodruma morph — resynthesize from a session cache (no re-analysis)\n"
      << "\n"
      << "  nodruma morph --session cache.bin --out out.wav [--model kick] [--params p.json]\n";
}

void usage_for(const std::string& cmd) {
  if (cmd == "process") usage_process();
  else if (cmd == "split") usage_split();
  else if (cmd == "detect") usage_detect();
  else if (cmd == "morph") usage_morph();
  else if (cmd == "info")
    std::cout << "nodruma info [--model kick|snare|hat]\n";
  else if (cmd == "version")
    std::cout << "nodruma version\n";
  else
    usage_overview();
}

std::string arg_value(const std::vector<std::string>& args, const std::string& key) {
  for (std::size_t i = 0; i + 1 < args.size(); ++i) {
    if (args[i] == key) return args[i + 1];
  }
  return {};
}

bool has_flag(const std::vector<std::string>& args, const std::string& key) {
  for (const auto& a : args)
    if (a == key) return true;
  return false;
}

bool wants_help(const std::vector<std::string>& args) {
  return has_flag(args, "-h") || has_flag(args, "--help") || has_flag(args, "help");
}

bool load_params_file(const std::string& path, nodruma::ModelParams& p) {
  if (path.empty()) return true;
  std::ifstream f(path);
  if (!f) return false;
  std::ostringstream ss;
  ss << f.rdbuf();
  return nodruma::params_from_json(ss.str(), p);
}

int cmd_info(const std::vector<std::string>& args) {
  if (wants_help(args)) {
    usage_for("info");
    return 0;
  }
  const std::string mid = arg_value(args, "--model");
  if (mid.empty()) {
    std::cout << "models:\n";
    for (const auto& id : nodruma::list_models()) {
      auto m = nodruma::create_model(id);
      std::cout << "  " << id << " — " << m->name() << ": " << m->description() << '\n';
    }
    return 0;
  }
  auto m = nodruma::create_model(mid);
  if (!m) {
    std::cerr << "unknown model: " << mid << " (try: nodruma info)\n";
    return 1;
  }
  std::cout << "id: " << m->id() << '\n'
            << "name: " << m->name() << '\n'
            << "description: " << m->description() << '\n';
  return 0;
}

int cmd_detect(const std::vector<std::string>& args) {
  if (wants_help(args)) {
    usage_detect();
    return 0;
  }
  const std::string in = arg_value(args, "--in");
  const std::string model_id = arg_value(args, "--model");
  const std::string onset_path = arg_value(args, "--write-onset");
  if (in.empty()) {
    std::cerr << "missing --in\n\n";
    usage_detect();
    return 1;
  }
  auto model = nodruma::create_model(model_id.empty() ? "kick" : model_id);
  if (!model) {
    std::cerr << "unknown model: " << model_id << '\n';
    return 1;
  }
  nodruma::Session session;
  session.set_model(std::move(model));
  nodruma::AudioBuffer buf;
  if (!nodruma::load_wav(in, buf)) {
    std::cerr << "failed to load " << in << " (need a readable WAV)\n";
    return 1;
  }
  session.set_input(std::move(buf));
  nodruma::Engine eng;
  eng.detect(session);
  const auto& o = session.cache().onset;
  std::cout << "primary_onset_sample=" << o.primary_onset << '\n';
  std::cout << "num_onsets=" << o.onsets.size() << '\n';
  if (!onset_path.empty()) {
    std::ofstream f(onset_path);
    if (!f) {
      std::cerr << "failed to write " << onset_path << '\n';
      return 1;
    }
    f << "sample,flux\n";
    for (std::size_t i = 0; i < o.flux_samples.size(); ++i) {
      f << i << ',' << o.flux_samples[i] << '\n';
    }
    std::cout << "wrote " << onset_path << '\n';
  }
  return 0;
}

int cmd_process(const std::vector<std::string>& args) {
  if (wants_help(args)) {
    usage_process();
    return 0;
  }
  const std::string in = arg_value(args, "--in");
  const std::string out = arg_value(args, "--out");
  const std::string model_id = arg_value(args, "--model");
  const std::string params_path = arg_value(args, "--params");
  const std::string dump = arg_value(args, "--dump-layers");
  const std::string cache_out = arg_value(args, "--write-session");
  if (in.empty() || out.empty()) {
    std::cerr << "missing --in and/or --out\n\n";
    usage_process();
    return 1;
  }
  auto model = nodruma::create_model(model_id.empty() ? "kick" : model_id);
  if (!model) {
    std::cerr << "unknown model: " << model_id << " (try: nodruma info)\n";
    return 1;
  }
  nodruma::Session session;
  session.set_model(std::move(model));
  nodruma::ModelParams params = session.params();
  if (!load_params_file(params_path, params)) {
    std::cerr << "failed to load params from " << params_path << '\n';
    return 1;
  }
  session.set_params(params);

  nodruma::AudioBuffer buf;
  if (!nodruma::load_wav(in, buf)) {
    std::cerr << "failed to load " << in << " (need a readable WAV)\n";
    return 1;
  }
  session.set_input(std::move(buf));

  nodruma::ProcessOptions opts;
  opts.dump_layers = !dump.empty();
  opts.layer_dump_dir = dump;

  nodruma::Engine eng;
  auto result = eng.process(session, opts);
  if (result.empty()) {
    std::cerr << "process failed (empty output)\n";
    return 1;
  }
  if (!nodruma::save_wav(out, result)) {
    std::cerr << "failed to write " << out << '\n';
    return 1;
  }
  std::cout << "wrote " << out << " (" << result.num_frames() << " frames, model="
            << session.model()->id() << ")\n";
  if (!cache_out.empty()) {
    if (!session.save_cache(cache_out))
      std::cerr << "warning: failed to write session cache\n";
    else
      std::cout << "wrote session " << cache_out << '\n';
  }
  return 0;
}

int cmd_split(const std::vector<std::string>& args) {
  if (wants_help(args)) {
    usage_split();
    return 0;
  }
  const std::string in = arg_value(args, "--in");
  const std::string out_dir = arg_value(args, "--out-dir");
  const std::string prefix = arg_value(args, "--prefix");
  if (in.empty() || out_dir.empty()) {
    std::cerr << "missing --in and/or --out-dir\n\n";
    usage_split();
    return 1;
  }

  nodruma::SplitOptions opts;
  try {
    if (const std::string t = arg_value(args, "--threshold"); !t.empty())
      opts.threshold_scale = std::stof(t);
    if (const std::string g = arg_value(args, "--min-gap"); !g.empty())
      opts.min_gap_sec = std::stof(g);
    if (const std::string m = arg_value(args, "--max-hit"); !m.empty())
      opts.max_hit_sec = std::stof(m);
  } catch (const std::exception&) {
    std::cerr << "invalid numeric option (threshold / min-gap / max-hit)\n";
    return 1;
  }
  opts.classify = !has_flag(args, "--no-classify");
  const bool do_extract = has_flag(args, "--extract");

  nodruma::AudioBuffer buf;
  if (!nodruma::load_wav(in, buf)) {
    std::cerr << "failed to load " << in << " (need a readable WAV)\n";
    return 1;
  }

  const auto split = nodruma::split_groove(buf, opts);
  if (split.hits.empty()) {
    std::cerr << "no hits found — try lowering --threshold (e.g. 0.7)\n";
    return 1;
  }
  if (!nodruma::export_split(buf, split, out_dir, prefix)) {
    std::cerr << "failed to export split to " << out_dir << '\n';
    return 1;
  }

  int n_kick = 0, n_snare = 0, n_hat = 0, n_unknown = 0;
  std::cout << "hits=" << split.hits.size() << " → " << out_dir << "/\n";
  for (std::size_t i = 0; i < split.hits.size(); ++i) {
    const auto& h = split.hits[i];
    switch (h.kind) {
      case nodruma::HitKind::Kick: ++n_kick; break;
      case nodruma::HitKind::Snare: ++n_snare; break;
      case nodruma::HitKind::Hat: ++n_hat; break;
      default: ++n_unknown; break;
    }
    const float t = static_cast<float>(h.onset_sample) / static_cast<float>(buf.sample_rate());
    std::cout << "  [" << i << "] " << nodruma::hit_kind_name(h.kind) << "  t=" << t << "s"
              << "  conf=" << h.confidence << "  lf=" << h.lf_ratio << "  hf=" << h.hf_ratio
              << '\n';
  }
  std::cout << "summary: kick=" << n_kick << " snare=" << n_snare << " hat=" << n_hat
            << " unknown=" << n_unknown << '\n';
  std::cout << "wrote " << out_dir << "/hits.json\n";

  if (!do_extract) {
    std::cout << "tip: add --extract to recreate classified hits under " << out_dir
              << "/extracted/\n";
    return 0;
  }

  namespace fs = std::filesystem;
  const fs::path extract_dir = fs::path(out_dir) / "extracted";
  std::error_code ec;
  fs::create_directories(extract_dir, ec);
  if (ec) {
    std::cerr << "failed to create " << extract_dir << '\n';
    return 1;
  }

  nodruma::Engine eng;
  int extracted = 0;
  int skipped_unknown = 0;
  for (std::size_t i = 0; i < split.hits.size(); ++i) {
    const auto& h = split.hits[i];
    const char* model_id = nullptr;
    if (h.kind == nodruma::HitKind::Kick)
      model_id = "kick";
    else if (h.kind == nodruma::HitKind::Snare)
      model_id = "snare";
    else if (h.kind == nodruma::HitKind::Hat)
      model_id = "hat";
    else {
      ++skipped_unknown;
      continue;
    }

    nodruma::AudioBuffer one = nodruma::extract_hit(buf, h);
    if (one.empty()) continue;

    nodruma::Session session;
    session.set_model(nodruma::create_model(model_id));
    session.set_input(std::move(one));
    auto result = eng.process(session);
    if (result.empty()) {
      std::cerr << "warning: extract failed for hit " << i << " (" << model_id << ")\n";
      continue;
    }

    char num[32];
    std::snprintf(num, sizeof(num), "%03zu", i);
    const fs::path out =
        extract_dir / (std::string(num) + "_" + model_id + "_nodruma.wav");
    if (!nodruma::save_wav(out.string(), result)) {
      std::cerr << "warning: failed to write " << out << '\n';
      continue;
    }
    std::cout << "extracted " << out << '\n';
    ++extracted;
  }
  std::cout << "extracted=" << extracted << " under " << extract_dir << '\n';
  if (skipped_unknown > 0) {
    std::cout << "skipped " << skipped_unknown
              << " unknown hit(s) — chops are still in " << out_dir
              << " (process manually with --model)\n";
  }
  return 0;
}

int cmd_morph(const std::vector<std::string>& args) {
  if (wants_help(args)) {
    usage_morph();
    return 0;
  }
  const std::string cache = arg_value(args, "--session");
  const std::string out = arg_value(args, "--out");
  const std::string model_id = arg_value(args, "--model");
  const std::string params_path = arg_value(args, "--params");
  if (cache.empty() || out.empty()) {
    std::cerr << "missing --session and/or --out\n\n";
    usage_morph();
    return 1;
  }
  auto model = nodruma::create_model(model_id.empty() ? "kick" : model_id);
  if (!model) {
    std::cerr << "unknown model: " << model_id << '\n';
    return 1;
  }
  nodruma::Session session;
  session.set_model(std::move(model));
  if (!session.load_cache(cache)) {
    std::cerr << "failed to load session cache " << cache << '\n';
    return 1;
  }
  nodruma::ModelParams params = session.params();
  if (!load_params_file(params_path, params)) {
    std::cerr << "failed to load params from " << params_path << '\n';
    return 1;
  }
  session.set_params(params);
  nodruma::Engine eng;
  auto result = eng.resynthesize(session);
  if (result.empty() || !nodruma::save_wav(out, result)) {
    std::cerr << "morph failed\n";
    return 1;
  }
  std::cout << "wrote " << out << '\n';
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  std::vector<std::string> args;
  for (int i = 1; i < argc; ++i) args.emplace_back(argv[i]);
  if (args.empty()) {
    usage_overview();
    return 1;
  }
  if (args.front() == "help" || args.front() == "-h" || args.front() == "--help") {
    if (args.size() >= 2) usage_for(args[1]);
    else usage_overview();
    return 0;
  }
  const std::string cmd = args.front();
  if (cmd == "version") {
    std::cout << nodruma_version() << '\n';
    return 0;
  }
  if (cmd == "info") return cmd_info(args);
  if (cmd == "detect") return cmd_detect(args);
  if (cmd == "process") return cmd_process(args);
  if (cmd == "split") return cmd_split(args);
  if (cmd == "morph") return cmd_morph(args);
  std::cerr << "unknown command: " << cmd << "\n\n";
  usage_overview();
  return 1;
}
