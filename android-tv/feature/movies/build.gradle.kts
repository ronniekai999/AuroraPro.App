plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

android {
    namespace = "io.aurora.tv.feature.movies"
    compileSdk = 35
    defaultConfig { minSdk = 28 }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(project(":core:design"))
    implementation(project(":core:ui"))
    // Phase 1 backend wiring: MoviesRepository consumes AuroraApi (network)
    // via AuroraApiProvider (auth). The auth dependency is what makes the
    // ServerUrlStore-aware Retrofit instance available; the network
    // dependency is what gives us the AuroraApi interface and DTOs.
    implementation(project(":core:auth"))
    implementation(project(":core:network"))

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.animation)
    implementation(libs.compose.tv.foundation)
    implementation(libs.compose.tv.material)
    implementation(libs.compose.material.icons.extended)

    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)

    implementation(libs.hilt.android)
    implementation(libs.hilt.navigation.compose)
    ksp(libs.hilt.compiler)

    implementation(libs.kotlin.coroutines.core)
    implementation(libs.kotlin.serialization.json)

    // Coil — same pattern as feature:home. The :app module configures
    // the singleton ImageLoader; this dep gives Movies access to
    // SubcomposeAsyncImage for the hero backdrop.
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
}
