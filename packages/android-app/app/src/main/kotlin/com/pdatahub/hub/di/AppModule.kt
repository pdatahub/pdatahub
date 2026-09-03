package com.pdatahub.hub.di

import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

/**
 * Hilt module for app-wide bindings.
 *
 * Most classes are wired via @Inject constructors and don't need explicit
 * @Provides methods. This module is reserved for cross-cutting providers
 * (e.g. Tink keyset, OkHttp interceptors).
 */
@Module
@InstallIn(SingletonComponent::class)
object AppModule
