#include <napi.h>
#include <uv.h>

#include <cstdint>
#include <cstring>
#include <exception>
#include <memory>
#include <string>
#include <vector>

#include "echo_service.hpp"
#include "service_registry.hpp"
#include "native_service.hpp"

#ifdef NATIVE_HOST_DB
#include "db_service.hpp"
#endif

#include <native/native_process.hpp>

extern "C" {
#include <io/circular_buffer.h>
}

namespace {

  using waos::native::native_process;
  using waos::native_host::registry;

  enum class buffer_direction : int {
    input = 0,
    output = 1,
  };

  buffer_direction parse_direction(const Napi::Value& value) {
    if(!value.IsString()) {
      throw Napi::TypeError::New(value.Env(), "direction must be 'input' or 'output'");
    }
    std::string dir = value.As<Napi::String>().Utf8Value();
    if(dir == "input") {
      return buffer_direction::input;
    }
    if(dir == "output") {
      return buffer_direction::output;
    }
    throw Napi::TypeError::New(value.Env(), "direction must be 'input' or 'output'");
  }

  circular_buffer& select_buffer(native_process& proc, std::uint32_t socket, buffer_direction dir) {
    if(dir == buffer_direction::input) {
      return proc.input_buffer(socket);
    }
    return proc.output_buffer(socket);
  }

  class NativeProcessHandle : public Napi::ObjectWrap<NativeProcessHandle> {
    public:
      static Napi::FunctionReference constructor;

      static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        Napi::Function func = DefineClass(env, "NativeProcessHandle", {});
        constructor = Napi::Persistent(func);
        constructor.SuppressDestruct();
        exports.Set("NativeProcessHandle", func);
        return exports;
      }

      NativeProcessHandle(const Napi::CallbackInfo& info)
          : Napi::ObjectWrap<NativeProcessHandle>(info) {}

      std::unique_ptr<waos::native_host::native_service> service;
      std::string service_type;
      // Sync JS callbacks: I/O owner is the JS thread for v1.
      Napi::FunctionReference flush_cb;
      Napi::FunctionReference drain_cb;
      uv_async_t io_wake_async{};
      bool io_wake_async_open = false;

      static NativeProcessHandle* UnwrapHandle(const Napi::Value& value) {
        if(!value.IsObject()) {
          throw Napi::TypeError::New(value.Env(), "expected NativeProcessHandle");
        }
        return Napi::ObjectWrap<NativeProcessHandle>::Unwrap(value.As<Napi::Object>());
      }
  };

  native_process* try_np(NativeProcessHandle* wrap) {
    if(!wrap || !wrap->service) {
      return nullptr;
    }
    return &wrap->service->process();
  }

  native_process& np(NativeProcessHandle* wrap) {
    auto* p = try_np(wrap);
    if(!p) {
      throw Napi::Error::New(wrap->Env(), "native process not created");
    }
    return *p;
  }

  Napi::FunctionReference NativeProcessHandle::constructor;

  void on_io_wake(uv_async_t* handle) {
    auto* wrap = static_cast<NativeProcessHandle*>(handle->data);
    if(!wrap || !wrap->service) {
      return;
    }
    try {
      auto& proc = wrap->service->process();
      for(std::uint32_t s = 0; s < proc.socket_count(); ++s) {
        if(proc.is_socket_open(s)) {
          proc.handle_drain(s);
        }
      }
    } catch(...) {
    }
  }

  Napi::Value CreateNativeProcess(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if(info.Length() < 3) {
      throw Napi::TypeError::New(env, "createNativeProcess(serviceType, id, socketCount, opts?)");
    }
    std::string service_type = info[0].As<Napi::String>().Utf8Value();
    std::uint32_t id = info[1].As<Napi::Number>().Uint32Value();
    std::uint32_t socket_count = info[2].As<Napi::Number>().Uint32Value();
    waos::native_host::service_create_opts opts;
    if(info.Length() > 3 && info[3].IsObject()) {
      Napi::Object o = info[3].As<Napi::Object>();
      if(o.Has("dataDir") && o.Get("dataDir").IsString()) {
        opts.data_dir = o.Get("dataDir").As<Napi::String>().Utf8Value();
      }
      if(o.Has("bufSize") && o.Get("bufSize").IsNumber()) {
        opts.buf_size = o.Get("bufSize").As<Napi::Number>().Uint32Value();
      }
    }

    Napi::Object obj = NativeProcessHandle::constructor.New({});
    auto* wrap = NativeProcessHandle::Unwrap(obj);
    wrap->service_type = service_type;
    try {
      wrap->service = registry().create(service_type, id, socket_count, opts);
    } catch(const std::exception& e) {
      throw Napi::Error::New(env, e.what());
    }
    uv_loop_t* loop = nullptr;
    napi_get_uv_event_loop(env, &loop);
    uv_async_init(loop, &wrap->io_wake_async, on_io_wake);
    wrap->io_wake_async.data = wrap;
    wrap->io_wake_async_open = true;
    // Echo does not wait on WAL completions. Unref so mocha can exit if the
    // test skips kill(). DB fill/batch needs the handle to keep the loop alive
    // until uv_async_send from the WAL worker.
    if(service_type != "db") {
      uv_unref(reinterpret_cast<uv_handle_t*>(&wrap->io_wake_async));
    }
    wrap->service->set_io_wake([wrap]() {
      if(wrap->io_wake_async_open) {
        uv_async_send(&wrap->io_wake_async);
      }
    });
    return obj;
  }

  Napi::Value OpenSocket(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto* wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    std::uint32_t index = info[1].As<Napi::Number>().Uint32Value();
    std::uint32_t buf_size = info[2].As<Napi::Number>().Uint32Value();
    np(wrap).open_socket(index, buf_size);
    wrap->service->on_socket_opened(index);
    return env.Undefined();
  }

  Napi::Value CloseSocket(const Napi::CallbackInfo& info) {
    auto* wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    std::uint32_t index = info[1].As<Napi::Number>().Uint32Value();
    np(wrap).close_socket(index);
    return info.Env().Undefined();
  }

  Napi::Value IsSocketOpen(const Napi::CallbackInfo& info) {
    auto* wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    std::uint32_t index = info[1].As<Napi::Number>().Uint32Value();
    return Napi::Boolean::New(info.Env(), np(wrap).is_socket_open(index));
  }

  Napi::Value HandleData(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto* wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    auto* proc = try_np(wrap);
    if(!proc) {
      return env.Undefined();
    }
    try {
      proc->handle_data(info[1].As<Napi::Number>().Uint32Value());
    } catch(const std::exception& e) {
      throw Napi::Error::New(env, e.what());
    }
    return env.Undefined();
  }

  Napi::Value HandleDrain(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto* wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    auto* proc = try_np(wrap);
    if(!proc) {
      return env.Undefined();
    }
    try {
      proc->handle_drain(info[1].As<Napi::Number>().Uint32Value());
    } catch(const std::exception& e) {
      throw Napi::Error::New(env, e.what());
    }
    return env.Undefined();
  }

  Napi::Value Flush(const Napi::CallbackInfo& info) {
    auto* wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    np(wrap).flush(info[1].As<Napi::Number>().Uint32Value());
    return info.Env().Undefined();
  }

  Napi::Value Drain(const Napi::CallbackInfo& info) {
    auto* wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    np(wrap).drain(info[1].As<Napi::Number>().Uint32Value());
    return info.Env().Undefined();
  }

  Napi::Value SetFlushCallback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto* wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    wrap->flush_cb = Napi::Persistent(info[1].As<Napi::Function>());
    wrap->flush_cb.SuppressDestruct();
    np(wrap).set_flush_callback([wrap](std::uint32_t socket) {
      if(wrap->flush_cb.IsEmpty()) {
        return;
      }
      try {
        Napi::Env env = wrap->flush_cb.Env();
        Napi::HandleScope scope(env);
        wrap->flush_cb.Call({Napi::Number::New(env, socket)});
      } catch(...) {
      }
    });
    return env.Undefined();
  }

  Napi::Value SetDrainCallback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto* wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    wrap->drain_cb = Napi::Persistent(info[1].As<Napi::Function>());
    wrap->drain_cb.SuppressDestruct();
    np(wrap).set_drain_callback([wrap](std::uint32_t socket) {
      if(wrap->drain_cb.IsEmpty()) {
        return;
      }
      try {
        Napi::Env env = wrap->drain_cb.Env();
        Napi::HandleScope scope(env);
        wrap->drain_cb.Call({Napi::Number::New(env, socket)});
      } catch(...) {
      }
    });
    return env.Undefined();
  }

  Napi::Value RegisterSocketHandler(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto* wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    std::uint32_t index = info[1].As<Napi::Number>().Uint32Value();

    auto data_ref = std::make_shared<Napi::FunctionReference>(
        Napi::Persistent(info[2].As<Napi::Function>()));
    data_ref->SuppressDestruct();

    std::shared_ptr<Napi::FunctionReference> drain_ref;
    if(info.Length() > 3 && info[3].IsFunction()) {
      drain_ref = std::make_shared<Napi::FunctionReference>(
          Napi::Persistent(info[3].As<Napi::Function>()));
      drain_ref->SuppressDestruct();
    }

    np(wrap).register_socket_handler(
        index,
        [data_ref, index]() {
          Napi::Env env = data_ref->Env();
          Napi::HandleScope scope(env);
          data_ref->Call({Napi::Number::New(env, index)});
        },
        drain_ref
            ? std::function<void()>([drain_ref, index]() {
                Napi::Env env = drain_ref->Env();
                Napi::HandleScope scope(env);
                drain_ref->Call({Napi::Number::New(env, index)});
              })
            : std::function<void()>());
    return env.Undefined();
  }

  Napi::Value Kill(const Napi::CallbackInfo& info) {
    auto* wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    if(wrap->service) {
      wrap->service->set_io_wake({});
      wrap->service->kill();
      wrap->service.reset();
    }
    if(wrap->io_wake_async_open) {
      wrap->io_wake_async_open = false;
      uv_close(reinterpret_cast<uv_handle_t*>(&wrap->io_wake_async), nullptr);
    }
    wrap->flush_cb.Reset();
    wrap->drain_cb.Reset();
    return info.Env().Undefined();
  }

  Napi::Value IsAlive(const Napi::CallbackInfo& info) {
    auto* wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    auto* proc = try_np(wrap);
    return Napi::Boolean::New(info.Env(), proc && proc->is_alive());
  }

  Napi::Value Id(const Napi::CallbackInfo& info) {
    auto* wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    return Napi::Number::New(info.Env(), static_cast<double>(np(wrap).id()));
  }

  Napi::Value SocketCount(const Napi::CallbackInfo& info) {
    auto* wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    return Napi::Number::New(info.Env(), static_cast<double>(np(wrap).socket_count()));
  }

  Napi::Value BufferRef(const Napi::CallbackInfo& info, buffer_direction fixed_dir) {
    Napi::Env env = info.Env();
    auto* wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    std::uint32_t index = info[1].As<Napi::Number>().Uint32Value();
    circular_buffer& buf = select_buffer(np(wrap), index, fixed_dir);
    if(buf.data == nullptr) {
      throw Napi::Error::New(env, "buffer not initialized");
    }

    // External ArrayBuffer over circular_buffer_data allocation.
    // Physical allocation is sizeof(header fields) + capacity data + 1.
    // size field stores initial_size + HEADER_SIZE(12) + 1.
    size_t logical_size = buf.data->size;
    size_t alloc_size = sizeof(size_t) * 3 + (logical_size - 12);
    Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(
        env,
        buf.data,
        alloc_size,
        [](Napi::Env, void*) {
          // Memory owned by native_process / circular_buffer.
        });

    Napi::Object result = Napi::Object::New(env);
    result.Set("externalArrayBuffer", ab);
    result.Set("byteOffset", Napi::Number::New(env, 0));
    result.Set("size", Napi::Number::New(env, static_cast<double>(alloc_size)));
    return result;
  }

  Napi::Value InputBufferRef(const Napi::CallbackInfo& info) {
    return BufferRef(info, buffer_direction::input);
  }

  Napi::Value OutputBufferRef(const Napi::CallbackInfo& info) {
    return BufferRef(info, buffer_direction::output);
  }

  circular_buffer& buffer_from_args(const Napi::CallbackInfo& info) {
    auto* wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    std::uint32_t index = info[1].As<Napi::Number>().Uint32Value();
    buffer_direction dir = parse_direction(info[2]);
    return select_buffer(np(wrap), index, dir);
  }

  Napi::Value BufferReadableBytes(const Napi::CallbackInfo& info) {
    circular_buffer& buf = buffer_from_args(info);
    return Napi::Number::New(info.Env(), static_cast<double>(circular_buffer_readable_bytes(&buf)));
  }

  Napi::Value BufferWritableBytes(const Napi::CallbackInfo& info) {
    circular_buffer& buf = buffer_from_args(info);
    return Napi::Number::New(info.Env(), static_cast<double>(circular_buffer_writable_bytes(&buf)));
  }

  Napi::Value BufferCapacity(const Napi::CallbackInfo& info) {
    circular_buffer& buf = buffer_from_args(info);
    return Napi::Number::New(info.Env(), static_cast<double>(circular_buffer_capacity(&buf)));
  }

  Napi::Value BufferGetSize(const Napi::CallbackInfo& info) {
    circular_buffer& buf = buffer_from_args(info);
    return Napi::Number::New(info.Env(), static_cast<double>(buf.data->size));
  }

  Napi::Value BufferGetReadOffset(const Napi::CallbackInfo& info) {
    circular_buffer& buf = buffer_from_args(info);
    return Napi::Number::New(info.Env(), static_cast<double>(buf.data->read_offset));
  }

  Napi::Value BufferSetReadOffset(const Napi::CallbackInfo& info) {
    circular_buffer& buf = buffer_from_args(info);
    buf.data->read_offset = info[3].As<Napi::Number>().Uint32Value();
    return info.Env().Undefined();
  }

  Napi::Value BufferGetWriteOffset(const Napi::CallbackInfo& info) {
    circular_buffer& buf = buffer_from_args(info);
    return Napi::Number::New(info.Env(), static_cast<double>(buf.data->write_offset));
  }

  Napi::Value BufferSetWriteOffset(const Napi::CallbackInfo& info) {
    circular_buffer& buf = buffer_from_args(info);
    buf.data->write_offset = info[3].As<Napi::Number>().Uint32Value();
    return info.Env().Undefined();
  }

  const uint8_t* bytes_ptr(const Napi::Value& value, size_t& length) {
    if(value.IsBuffer()) {
      Napi::Buffer<uint8_t> buf = value.As<Napi::Buffer<uint8_t>>();
      length = buf.Length();
      return buf.Data();
    }
    if(value.IsTypedArray()) {
      Napi::TypedArray ta = value.As<Napi::TypedArray>();
      Napi::ArrayBuffer ab = ta.ArrayBuffer();
      length = ta.ByteLength();
      return static_cast<const uint8_t*>(ab.Data()) + ta.ByteOffset();
    }
    throw Napi::TypeError::New(value.Env(), "expected Buffer or TypedArray");
  }

  Napi::Value BufferWrite(const Napi::CallbackInfo& info) {
    circular_buffer& buf = buffer_from_args(info);
    size_t src_len = 0;
    const uint8_t* src = bytes_ptr(info[3], src_len);
    size_t bytes = info[4].As<Napi::Number>().Uint32Value();
    if(bytes > src_len) {
      bytes = src_len;
    }
    size_t written = circular_buffer_write(&buf, src, bytes);
    return Napi::Number::New(info.Env(), static_cast<double>(written));
  }

  Napi::Value BufferRead(const Napi::CallbackInfo& info) {
    circular_buffer& buf = buffer_from_args(info);
    Napi::TypedArray ta = info[3].As<Napi::TypedArray>();
    Napi::ArrayBuffer ab = ta.ArrayBuffer();
    uint8_t* dest = static_cast<uint8_t*>(ab.Data()) + ta.ByteOffset();
    size_t dest_len = ta.ByteLength();
    size_t bytes = info[4].As<Napi::Number>().Uint32Value();
    if(bytes > dest_len) {
      bytes = dest_len;
    }
    size_t read = circular_buffer_read(&buf, dest, bytes);
    return Napi::Number::New(info.Env(), static_cast<double>(read));
  }

  Napi::Value BufferPeek(const Napi::CallbackInfo& info) {
    circular_buffer& buf = buffer_from_args(info);
    size_t offset = info[3].As<Napi::Number>().Uint32Value();
    Napi::TypedArray ta = info[4].As<Napi::TypedArray>();
    Napi::ArrayBuffer ab = ta.ArrayBuffer();
    uint8_t* dest = static_cast<uint8_t*>(ab.Data()) + ta.ByteOffset();
    size_t dest_len = ta.ByteLength();
    size_t bytes = info[5].As<Napi::Number>().Uint32Value();
    if(bytes > dest_len) {
      bytes = dest_len;
    }
    size_t peeked = circular_buffer_peek(&buf, offset, dest, bytes);
    return Napi::Number::New(info.Env(), static_cast<double>(peeked));
  }

  Napi::Value BufferPoke(const Napi::CallbackInfo& info) {
    circular_buffer& buf = buffer_from_args(info);
    size_t offset = info[3].As<Napi::Number>().Uint32Value();
    size_t src_len = 0;
    const uint8_t* src = bytes_ptr(info[4], src_len);
    size_t bytes = info[5].As<Napi::Number>().Uint32Value();
    if(bytes > src_len) {
      bytes = src_len;
    }
    size_t poked = circular_buffer_poke(&buf, offset, src, bytes);
    return Napi::Number::New(info.Env(), static_cast<double>(poked));
  }

  Napi::Value BufferSkipRead(const Napi::CallbackInfo& info) {
    circular_buffer& buf = buffer_from_args(info);
    size_t bytes = info[3].As<Napi::Number>().Uint32Value();
    size_t skipped = circular_buffer_skip_read(&buf, bytes);
    return Napi::Number::New(info.Env(), static_cast<double>(skipped));
  }

  Napi::Value BufferCommitWrite(const Napi::CallbackInfo& info) {
    circular_buffer& buf = buffer_from_args(info);
    size_t bytes = info[3].As<Napi::Number>().Uint32Value();
    size_t committed = circular_buffer_commit_write(&buf, bytes);
    return Napi::Number::New(info.Env(), static_cast<double>(committed));
  }

  Napi::Value BufferClear(const Napi::CallbackInfo& info) {
    circular_buffer& buf = buffer_from_args(info);
    circular_buffer_clear(&buf);
    return info.Env().Undefined();
  }

  Napi::Value BufferReadableViews(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    circular_buffer& buf = buffer_from_args(info);
    size_t max_bytes = info[3].As<Napi::Number>().Uint32Value();
    size_t readable = circular_buffer_readable_bytes(&buf);
    size_t n = readable < max_bytes ? readable : max_bytes;

    Napi::Array result = Napi::Array::New(env);
    if(n == 0) {
      return result;
    }

    circular_buffer_segment segs[2];
    int count = circular_buffer_get_segments(&buf, 0, n, segs);
    uint32_t out_i = 0;
    for(int i = 0; i < count; ++i) {
      if(segs[i].len == 0 || segs[i].ptr == nullptr) {
        continue;
      }
      // External buffer: no copy, no free (owned by circular_buffer).
      Napi::Buffer<char> view = Napi::Buffer<char>::New(
          env,
          const_cast<char*>(segs[i].ptr),
          segs[i].len,
          [](Napi::Env, char*) {});
      result.Set(out_i++, view);
    }
    return result;
  }

  Napi::Value CopyToNative(const Napi::CallbackInfo& info) {
    auto* dest_wrap = NativeProcessHandle::UnwrapHandle(info[0]);
    std::uint32_t dest_socket = info[1].As<Napi::Number>().Uint32Value();
    buffer_direction dest_dir = parse_direction(info[2]);
    auto* src_wrap = NativeProcessHandle::UnwrapHandle(info[3]);
    std::uint32_t src_socket = info[4].As<Napi::Number>().Uint32Value();
    buffer_direction src_dir = parse_direction(info[5]);

    circular_buffer& src = select_buffer(np(src_wrap), src_socket, src_dir);
    circular_buffer& dest = select_buffer(np(dest_wrap), dest_socket, dest_dir);

    size_t readable = circular_buffer_readable_bytes(&src);
    size_t writable = circular_buffer_writable_bytes(&dest);
    size_t n = readable < writable ? readable : writable;
    if(n == 0) {
      return Napi::Number::New(info.Env(), 0);
    }

    circular_buffer_segment segs[2];
    int count = circular_buffer_get_segments(&src, 0, n, segs);
    size_t written_total = 0;
    for(int i = 0; i < count; ++i) {
      if(segs[i].len == 0 || segs[i].ptr == nullptr) {
        continue;
      }
      size_t w = circular_buffer_write(&dest, segs[i].ptr, segs[i].len);
      written_total += w;
      if(w < segs[i].len) {
        break;
      }
    }
    if(written_total > 0) {
      circular_buffer_skip_read(&src, written_total);
    }
    return Napi::Number::New(info.Env(), static_cast<double>(written_total));
  }

  Napi::Value ListServices(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto names = registry().list_services();
    Napi::Array result = Napi::Array::New(env, names.size());
    for(size_t i = 0; i < names.size(); ++i) {
      result.Set(i, Napi::String::New(env, names[i]));
    }
    return result;
  }

  Napi::Object Init(Napi::Env env, Napi::Object exports) {
    waos::native_host::register_echo_service();
#ifdef NATIVE_HOST_DB
    waos::native_host::register_db_service();
#endif

    NativeProcessHandle::Init(env, exports);

    exports.Set("createNativeProcess", Napi::Function::New(env, CreateNativeProcess));
    exports.Set("openSocket", Napi::Function::New(env, OpenSocket));
    exports.Set("closeSocket", Napi::Function::New(env, CloseSocket));
    exports.Set("isSocketOpen", Napi::Function::New(env, IsSocketOpen));
    exports.Set("handleData", Napi::Function::New(env, HandleData));
    exports.Set("handleDrain", Napi::Function::New(env, HandleDrain));
    exports.Set("flush", Napi::Function::New(env, Flush));
    exports.Set("drain", Napi::Function::New(env, Drain));
    exports.Set("setFlushCallback", Napi::Function::New(env, SetFlushCallback));
    exports.Set("setDrainCallback", Napi::Function::New(env, SetDrainCallback));
    exports.Set("registerSocketHandler", Napi::Function::New(env, RegisterSocketHandler));
    exports.Set("kill", Napi::Function::New(env, Kill));
    exports.Set("isAlive", Napi::Function::New(env, IsAlive));
    exports.Set("id", Napi::Function::New(env, Id));
    exports.Set("socketCount", Napi::Function::New(env, SocketCount));
    exports.Set("inputBufferRef", Napi::Function::New(env, InputBufferRef));
    exports.Set("outputBufferRef", Napi::Function::New(env, OutputBufferRef));
    exports.Set("bufferReadableBytes", Napi::Function::New(env, BufferReadableBytes));
    exports.Set("bufferWritableBytes", Napi::Function::New(env, BufferWritableBytes));
    exports.Set("bufferCapacity", Napi::Function::New(env, BufferCapacity));
    exports.Set("bufferGetSize", Napi::Function::New(env, BufferGetSize));
    exports.Set("bufferGetReadOffset", Napi::Function::New(env, BufferGetReadOffset));
    exports.Set("bufferSetReadOffset", Napi::Function::New(env, BufferSetReadOffset));
    exports.Set("bufferGetWriteOffset", Napi::Function::New(env, BufferGetWriteOffset));
    exports.Set("bufferSetWriteOffset", Napi::Function::New(env, BufferSetWriteOffset));
    exports.Set("bufferWrite", Napi::Function::New(env, BufferWrite));
    exports.Set("bufferRead", Napi::Function::New(env, BufferRead));
    exports.Set("bufferPeek", Napi::Function::New(env, BufferPeek));
    exports.Set("bufferPoke", Napi::Function::New(env, BufferPoke));
    exports.Set("bufferSkipRead", Napi::Function::New(env, BufferSkipRead));
    exports.Set("bufferCommitWrite", Napi::Function::New(env, BufferCommitWrite));
    exports.Set("bufferClear", Napi::Function::New(env, BufferClear));
    exports.Set("bufferReadableViews", Napi::Function::New(env, BufferReadableViews));
    exports.Set("copyToNative", Napi::Function::New(env, CopyToNative));
    exports.Set("listServices", Napi::Function::New(env, ListServices));
    return exports;
  }

}

NODE_API_MODULE(nativeHost, Init)
