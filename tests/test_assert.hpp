#pragma once

#include <cmath>
#include <iostream>

int& nodruma_test_failed();
int& nodruma_test_passed();

#define CHECK(cond)                                                                  \
  do {                                                                               \
    if (!(cond)) {                                                                   \
      std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << " : " << #cond << '\n'; \
      ++nodruma_test_failed();                                                       \
    } else {                                                                         \
      ++nodruma_test_passed();                                                       \
    }                                                                                \
  } while (0)

#define CHECK_NEAR(a, b, eps) CHECK(std::fabs(static_cast<double>(a) - static_cast<double>(b)) < (eps))
