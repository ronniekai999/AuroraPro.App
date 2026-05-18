// Top-level build file — no plugin application here; subprojects declare their own.
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.hilt) apply false
}

// Align Kotlin's JVM target with the Java compiler's target (17) across every module.
// We don't use kotlin { jvmToolchain(17) } because that forces Gradle to download a
// specific JDK; we'd rather use whatever JDK Android Studio / the shell already has
// (JBR 21 in practice) and just emit Java 17 bytecode from it.
subprojects {
    tasks.withType<KotlinJvmCompile>().configureEach {
        compilerOptions {
            jvmTarget.set(JvmTarget.JVM_17)
        }
    }

    // === Android Studio ↔ AGP 9.x task-name compatibility shim ===
    // Android Studio's Gradle integration still invokes `:<module>:unitTestClasses`
    // during project sync and as the default "Build Before Run" step. That task
    // name came from the legacy Gradle Java plugin convention and AGP 8.x
    // registered an alias for it. AGP 9 dropped the alias because the Android
    // variant system makes "which variant's tests?" ambiguous — the AGP 9
    // replacement is the per-variant `compileDebugUnitTestSources`.
    //
    // Until the IntelliJ Android plugin catches up to the AGP 9 task naming,
    // sync fails on "task not found". We register a shim on any module that
    // applies an Android plugin; the shim's `dependsOn(string)` is resolved
    // lazily, so it doesn't matter that AGP hasn't yet created the target
    // task at this point in configuration. Delete once Android Studio's
    // AGP-9 integration catches up.
    val androidProject = this
    val registerShim = {
        if (androidProject.tasks.findByName("unitTestClasses") == null) {
            androidProject.tasks.register("unitTestClasses") {
                group       = "verification"
                description = "AGP 9 compatibility alias — delegates to compileDebugUnitTestSources."
                dependsOn("compileDebugUnitTestSources")
            }
        }
    }
    plugins.withId("com.android.application") { registerShim() }
    plugins.withId("com.android.library")     { registerShim() }
}
