fn main() {
    std::process::exit(notechain::cli::execute(std::env::args().skip(1).collect()));
}
