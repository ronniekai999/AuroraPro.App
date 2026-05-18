package io.aurora.tv

// Anchor file for the JVM unit-test source set.
//
// AGP 9.x registers the `unitTestClasses` task (and its compile dependencies)
// only when a module actually has test sources. Without this file, Android
// Studio's Gradle sync and "Build Before Run" step fail with:
//     Cannot locate tasks that match ':app:unitTestClasses'
// because the task is never created.
//
// This file carries no declarations — its purpose is to make the source set
// non-empty so the task registration happens. Delete it once the first real
// test class lands.
