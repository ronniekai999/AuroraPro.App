package app.aurorapro.tv.data

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Aurora's API is served at the origin, even when its web UI is under /v2. */
fun serverAddress(input: String): HttpUrl {
    val text = input.trim().let { if ("://" in it) it else "https://$it" }
    val url = text.toHttpUrlOrNull() ?: throw IllegalArgumentException("Enter your Aurora server address.")
    require(url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null) {
        "Use the server address without credentials, query parameters or a fragment."
    }
    require(url.encodedPath in listOf("/", "/v2", "/v2/")) {
        "Use your server address, for example https://aurora.example.com."
    }
    if (!url.isHttps) require(isLocalHost(url.host)) { "Use HTTPS for a server outside your local network." }
    return url.newBuilder().encodedPath("/").build()
}

private fun isLocalHost(host: String): Boolean {
    if (host == "localhost" || host == "::1" || host.endsWith(".local") || host.endsWith(".lan")) return true
    val p = host.split('.').map { it.toIntOrNull() ?: return false }
    if (p.size != 4 || p.any { it !in 0..255 }) return false
    return p[0] == 10 || p[0] == 127 || (p[0] == 192 && p[1] == 168) ||
        (p[0] == 172 && p[1] in 16..31)
}

fun HttpUrl.sameOrigin(other: HttpUrl): Boolean = scheme == other.scheme && host == other.host && port == other.port
