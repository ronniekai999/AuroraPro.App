"""Bind FFmpeg encoder AVOptions without initializing hardware or encoding."""
import ctypes as C
import ctypes.util
import json
import sys

codec_lib = ctypes.util.find_library("avcodec")
util_lib = ctypes.util.find_library("avutil")
if not codec_lib or not util_lib:
    sys.exit("LIBAVCODEC_UNAVAILABLE: libavcodec/libavutil shared libraries required")
codec = C.CDLL(codec_lib)
util = C.CDLL(util_lib)
codec.avcodec_find_encoder_by_name.argtypes = [C.c_char_p]
codec.avcodec_find_encoder_by_name.restype = C.c_void_p
codec.avcodec_alloc_context3.argtypes = [C.c_void_p]
codec.avcodec_alloc_context3.restype = C.c_void_p
codec.avcodec_free_context.argtypes = [C.POINTER(C.c_void_p)]
util.av_opt_set.argtypes = [C.c_void_p, C.c_char_p, C.c_char_p, C.c_int]
util.av_opt_get_int.argtypes = [C.c_void_p, C.c_char_p, C.c_int, C.POINTER(C.c_int64)]
SEARCH_CHILDREN = 1

for case in json.load(sys.stdin):
    args = case["args"]
    name = args[args.index("-c:v") + 1]
    encoder = codec.avcodec_find_encoder_by_name(name.encode())
    if not encoder:
        sys.exit(f"LIBAVCODEC_UNAVAILABLE: installed FFmpeg lacks {name}")
    ctx = C.c_void_p(codec.avcodec_alloc_context3(encoder))
    if not ctx:
        sys.exit(f"unable to allocate {name} codec context")
    try:
        for option in ("level", "tier"):
            if option not in case:
                continue
            value = args[args.index("-" + option) + 1]
            result = util.av_opt_set(ctx, option.encode(), value.encode(), SEARCH_CHILDREN)
            assert result == 0, (name, option, value, result)
            parsed = C.c_int64()
            result = util.av_opt_get_int(ctx, option.encode(), SEARCH_CHILDREN, C.byref(parsed))
            assert result == 0, (name, option, result)
            assert parsed.value == case[option], (name, option, value, parsed.value, case[option])
    finally:
        codec.avcodec_free_context(C.byref(ctx))
