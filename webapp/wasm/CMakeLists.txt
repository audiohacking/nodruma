cmake_minimum_required(VERSION 3.20)
project(nodruma_wasm LANGUAGES CXX)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with emcmake/emcc (EMSCRIPTEN toolchain required)")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(NODRUMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(NODRUMA_BUILD_CLI OFF CACHE BOOL "" FORCE)

add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../.. ${CMAKE_BINARY_DIR}/nodruma_core_build
                 EXCLUDE_FROM_ALL)

add_executable(nodruma bridge.cpp)
target_link_libraries(nodruma PRIVATE nodruma::core)
target_compile_features(nodruma PRIVATE cxx_std_20)
target_include_directories(nodruma PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../../include
)

set_target_properties(nodruma PROPERTIES OUTPUT_NAME "nodruma")

target_link_options(nodruma PRIVATE
  "SHELL:-sALLOW_MEMORY_GROWTH=1"
  "SHELL:-sINITIAL_MEMORY=67108864"
  "SHELL:-sMAXIMUM_MEMORY=1073741824"
  "SHELL:-sSTACK_SIZE=2097152"
  "SHELL:-sMODULARIZE=1"
  "SHELL:-sEXPORT_NAME=createNodruma"
  "SHELL:-sENVIRONMENT=web,node"
  "SHELL:-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','getValue','setValue','UTF8ToString','HEAPF32','HEAPU8']"
  "SHELL:-sEXPORTED_FUNCTIONS=['_nd_malloc','_nd_free','_nd_version','_nd_clear_hits','_nd_split','_nd_hit_count','_nd_hit_pcm','_nd_recreate']"
  "SHELL:-O2"
  "SHELL:--no-entry"
)

set_target_properties(nodruma PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/.."
)
