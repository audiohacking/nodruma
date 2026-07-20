#include <cmath>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

static int g_failed = 0;
static int g_passed = 0;

#define CHECK(cond)                                                                  \
  do {                                                                               \
    if (!(cond)) {                                                                   \
      std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << " : " << #cond << '\n'; \
      ++g_failed;                                                                    \
    } else {                                                                         \
      ++g_passed;                                                                    \
    }                                                                                \
  } while (0)

#define CHECK_NEAR(a, b, eps) CHECK(std::fabs((a) - (b)) < (eps))

void test_fft();
void test_onset();
void test_extract();
void test_synth();
void test_models();
void test_bench();
void test_reference_fixtures();
void test_zc_pitch();
void test_body_cleanup();
void test_split();

int main() {
  test_fft();
  test_onset();
  test_extract();
  test_synth();
  test_models();
  test_bench();
  test_reference_fixtures();
  test_zc_pitch();
  test_body_cleanup();
  test_split();
  std::cout << "passed=" << g_passed << " failed=" << g_failed << '\n';
  return g_failed ? 1 : 0;
}

// Re-export macros for other TUs via including... tests define CHECK themselves.
// Provide shared symbols:
int& nodruma_test_failed() { return g_failed; }
int& nodruma_test_passed() { return g_passed; }
