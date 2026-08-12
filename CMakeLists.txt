cmake_minimum_required(VERSION 3.17)
project(nativeHost CXX C)

set(CMAKE_CXX_STANDARD 26)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(NATIVE_HOST_DB "Include DB service in this addon" OFF)

# cmake-js provides CMAKE_JS_INC / CMAKE_JS_SRC when invoked via cmake-js
if(NOT DEFINED CMAKE_JS_INC)
  message(FATAL_ERROR "Build with cmake-js (npm install / cmake-js compile)")
endif()

add_library(${PROJECT_NAME} SHARED
  src/native_process_addon.cpp
  src/service_registry.cpp
  src/echo_service.cpp
  ${CMAKE_SOURCE_DIR}/../cpp-rpc/src/native/native_process.cpp
  ${CMAKE_SOURCE_DIR}/../cpp-rpc/src/io/circular_buffer.c
  ${CMAKE_JS_SRC}
)

set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
  OUTPUT_NAME "nativeHost"
)

target_include_directories(${PROJECT_NAME} PRIVATE
  ${CMAKE_SOURCE_DIR}/../cpp-rpc/src
  ${CMAKE_SOURCE_DIR}/src
  ${CMAKE_JS_INC}
  ${CMAKE_SOURCE_DIR}/node_modules/node-addon-api
  ${CMAKE_SOURCE_DIR}/../node_modules/node-addon-api
)

target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_VERSION=8
  NODE_ADDON_API_DISABLE_DEPRECATED
)

if(NATIVE_HOST_DB)
  target_compile_definitions(${PROJECT_NAME} PRIVATE NATIVE_HOST_DB=1)
endif()

# Do not link libnode on Linux; cmake-js MODULE linking is sufficient
if(WIN32)
  target_link_libraries(${PROJECT_NAME} PRIVATE ${CMAKE_JS_LIB})
endif()
