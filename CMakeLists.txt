cmake_minimum_required(VERSION 3.20)
project(nodruma VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(NODRUMA_BUILD_TESTS "Build unit tests" ON)
option(NODRUMA_BUILD_SHARED "Build shared library" OFF)

add_library(nodruma_core
  src/core/audio_buffer.cpp
  src/core/fft.cpp
  src/core/smooth.cpp
  src/core/onset.cpp
  src/core/stft.cpp
  src/core/masks.cpp
  src/core/extract.cpp
  src/core/pitch_zc.cpp
  src/core/body_cleanup.cpp
  src/core/synth.cpp
  src/core/split.cpp
  src/core/mix.cpp
  src/core/session.cpp
  src/core/engine.cpp
  src/core/params.cpp
  src/core/wav_io.cpp
  src/core/c_api.cpp
  src/models/kick_ada.cpp
  src/models/snare_v1.cpp
  src/models/hat_v1.cpp
  src/models/registry.cpp
)

add_library(nodruma::core ALIAS nodruma_core)

target_include_directories(nodruma_core
  PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>
  PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)

target_compile_definitions(nodruma_core PRIVATE NODRUMA_VERSION="${PROJECT_VERSION}")

if(MSVC)
  target_compile_options(nodruma_core PRIVATE /W4)
else()
  target_compile_options(nodruma_core PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(nodruma_cli tools/nodruma_cli/main.cpp)
target_link_libraries(nodruma_cli PRIVATE nodruma::core)
target_include_directories(nodruma_cli PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)
set_target_properties(nodruma_cli PROPERTIES OUTPUT_NAME nodruma)

if(NODRUMA_BUILD_TESTS)
  enable_testing()
  add_executable(nodruma_tests
    tests/test_main.cpp
    tests/test_fft.cpp
    tests/test_onset.cpp
    tests/test_extract.cpp
    tests/test_synth.cpp
    tests/test_models.cpp
    tests/test_bench.cpp
    tests/test_reference.cpp
    tests/test_zc_cleanup.cpp
    tests/test_split.cpp
  )
  target_link_libraries(nodruma_tests PRIVATE nodruma::core)
  target_include_directories(nodruma_tests PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party
    ${CMAKE_CURRENT_SOURCE_DIR}/src
  )
  add_test(NAME nodruma_tests COMMAND nodruma_tests)
endif()

install(TARGETS nodruma_core nodruma_cli
  RUNTIME DESTINATION bin
  LIBRARY DESTINATION lib
  ARCHIVE DESTINATION lib
)
install(DIRECTORY include/nodruma DESTINATION include)
