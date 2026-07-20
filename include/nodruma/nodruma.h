#pragma once

#ifdef __cplusplus
extern "C" {
#endif

#include <stddef.h>

typedef struct NodrumaEngine NodrumaEngine;
typedef struct NodrumaSession NodrumaSession;

const char* nodruma_version(void);

NodrumaEngine* nodruma_engine_create(void);
void nodruma_engine_destroy(NodrumaEngine* eng);

NodrumaSession* nodruma_session_create(void);
void nodruma_session_destroy(NodrumaSession* sess);

int nodruma_session_set_model(NodrumaSession* sess, const char* model_id);
int nodruma_session_load_wav(NodrumaSession* sess, const char* path);
int nodruma_session_save_wav(const float* interleaved, size_t frames, size_t channels,
                             double sample_rate, const char* path);

/* Process: writes mono or stereo interleaved to out_interleaved (must be large enough).
   Returns number of frames written, or -1 on error. */
int nodruma_process(NodrumaEngine* eng, NodrumaSession* sess,
                    float* out_interleaved, size_t max_frames, size_t* out_channels);

#ifdef __cplusplus
}
#endif
