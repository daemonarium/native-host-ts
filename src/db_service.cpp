#include "db_service.hpp"
#include "native_service.hpp"
#include "service_registry.hpp"

#include <db_native_process.hpp>

#include <memory>
#include <stdexcept>
#include <utility>

namespace waos::native_host {
  namespace {

    class db_service final : public native_service {
      public:
        db_service(
            std::uint32_t id,
            std::uint32_t socket_count,
            const service_create_opts& opts) {
          if(opts.data_dir.empty()) {
            throw std::runtime_error("db service requires dataDir");
          }
          waos::db_native_process::options o;
          o.data_dir = opts.data_dir;
          o.process_id = id;
          o.socket_count = socket_count;
          o.buf_size = opts.buf_size == 0 ? 65536 : opts.buf_size;
          db_ = std::make_unique<waos::db_native_process>(std::move(o));
        }

        ~db_service() override {
          kill();
        }

        waos::native::native_process& process() override {
          return db_->process();
        }

        void kill() override {
          if(db_) {
            db_->kill();
          }
        }

        void on_socket_opened(std::uint32_t socket) override {
          if(socket == 0) {
            db_->open_control_socket();
          }
          auto* db = db_.get();
          db_->process().register_socket_handler(
              socket,
              [db, socket]() { db->handle_data(socket); },
              [db, socket]() { db->handle_drain(socket); });
        }

        void set_io_wake(std::function<void()> cb) override {
          db_->set_io_wake(std::move(cb));
        }

      private:
        std::unique_ptr<waos::db_native_process> db_;
    };

  }

  void register_db_service() {
    registry().register_service(
        "db",
        [](std::uint32_t id, std::uint32_t socket_count, const service_create_opts& opts) {
          return std::make_unique<db_service>(id, socket_count, opts);
        });
  }

}
