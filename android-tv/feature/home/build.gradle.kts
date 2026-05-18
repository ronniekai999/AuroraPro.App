plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

android {
    namespace = "io.aurora.tv.feature.home"
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
    // Phase 1 backend wiring: HomeRepository consumes AuroraApi (network)
    // via AuroraApiProvider (auth). Mirrors :feature:movies' setup.
    implementation(project(":core:auth"))
    implementation(project(":core:network"))

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.animation)
    implementation(libs.compose.tv.foundation)
    implementation(libs.compose.tv.material)

    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)

    implementation(libs.hilt.android)
    implementation(libs.hilt.navigation.compose)
    ksp(libs.hilt.compiler)

    implementation(libs.kotlin.coroutines.core)
    implementation(libs.kotlin.serialization.json)

    // Coil 3 for AsyncImage/SubcomposeAsyncImage. coil-network-okhttp puts an
    // OkHttp-based fetcher on the classpath; Coil's default SingletonImageLoader
    // auto-discovers it, so no manual ImageLoader configuration is needed.
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
}
