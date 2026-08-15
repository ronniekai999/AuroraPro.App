import AuroraKit
import AuroraUI
import SwiftUI

struct LoginView: View {
    let error: String?

    @Environment(AppState.self) private var state
    @State private var username = ""
    @State private var password = ""
    @State private var serverText = ""
    @State private var showServerField = false
    @FocusState private var focus: Field?

    private enum Field { case server, username, password }

    var body: some View {
        VStack(spacing: 20) {
            Text("Aurora")
                .font(.auroraDisplay(44))
                .auroraTextGradient()
                .padding(.bottom, 4)

            if showServerField {
                TextField("https://aurora.example.com", text: $serverText)
                    .textFieldStyle(.roundedBorder)
                    .focused($focus, equals: .server)
                    .onSubmit { focus = .username }
            } else {
                Button {
                    serverText = state.serverURL.absoluteString
                    showServerField = true
                    focus = .server
                } label: {
                    Text(state.serverURL.host ?? state.serverURL.absoluteString)
                        .font(.auroraBody)
                        .foregroundStyle(Color.auroraTextSecondary)
                }
                .buttonStyle(.plain)
                .help("Change server")
            }

            TextField("Username", text: $username)
                .textFieldStyle(.roundedBorder)
                .focused($focus, equals: .username)
                .onSubmit { focus = .password }

            SecureField("Password", text: $password)
                .textFieldStyle(.roundedBorder)
                .focused($focus, equals: .password)
                .onSubmit { submit() }

            if let error {
                Text(error)
                    .font(.auroraBody)
                    .foregroundStyle(Color.auroraDestructive)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button(action: submit) {
                if state.isLoading {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                } else {
                    Text("Sign In").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(AuroraButtonStyle())
            .disabled(state.isLoading || username.isEmpty || password.isEmpty)
        }
        .frame(width: 320)
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AuroraBackdrop())
        .onAppear { focus = .username }
    }

    private func submit() {
        guard !username.isEmpty, !password.isEmpty else { return }
        Task {
            if showServerField,
               let url = URL(string: serverText.trimmingCharacters(in: .whitespaces)),
               url != state.serverURL {
                await state.changeServer(to: url)
            }
            await state.signIn(username: username, password: password)
            password = ""
        }
    }
}
